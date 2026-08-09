# Panther Carts — Database Design (Ticket 1)

Authoritative reference for the schema and queue engine created in Ticket 1.
All queue mutations are PostgreSQL functions in `supabase/migrations/`, invoked
via Supabase RPC by trusted server operations only. No React/browser code may
call them (see `docs/ARCHITECTURE.md` and `CLAUDE.md`).

Migrations:

- `20260809120000_schema.sql` — enums, tables, constraints, indexes, RLS.
- `20260809120100_functions.sql` — helpers + queue-engine RPC functions.
- `20260809120200_views.sql` — reporting views.

## Tables

- **`sessions`** — a staffed rental session. Holds status, public student
  code, staff access code, rental duration, pickup-window duration, and
  lifecycle timestamps. Durations are constrained `> 0`.
- **`students`** — signup records (name, Panther ID, email, normalized phone)
  scoped to a session. Indexed by session, `(session, phone)`, and
  `(session, panther_id)`.
- **`bins`** — numbered cart bins. `bin_number` is text and unique per session.
  Status `AVAILABLE` / `RESERVED` / `OUT`. No condition or QR columns.
- **`queue_entries`** — the waitlist. Carries status, `queue_rank`, the
  four-digit `pickup_code` and `reserved_bin_id` while READY, and the one-time
  `hold_used` flag. `phone` is denormalized from the student so uniqueness can
  be enforced by index.
- **`reservations`** — a bin offered to a queue entry. Status `ACTIVE` /
  `CLAIMED` / `DEFERRED` / `EXPIRED` / `CANCELLED`.
- **`rentals`** — a checked-out cart. Status `OUT` / `RETURNED`. Records due
  time, PantherCard collect/return timestamps, staff labels, `was_late`, and
  checkout/return idempotency keys.
- **`notification_outbox`** — outbound SMS intents. Ticket 1 only writes rows;
  delivery is Ticket 5. `dedupe_key` is unique.
- **`audit_events`** — append-only audit log with JSON metadata.

### Personal data (deferred to Ticket 6)

Student PII is stored in plain columns. **Column-level encryption, retention
windows, and the RLS policies that limit who may read this data are Ticket 6.**
No real student data is seeded in this ticket.

## Enums / state machines

**Session:** `DRAFT → ACTIVE → CLOSED`.

**Bin:** `AVAILABLE → RESERVED` (on allocation) `→ OUT` (on checkout) `→
AVAILABLE` (on return). A reserved bin returns to `AVAILABLE` on reservation
expiry or a checkout swap.

**Queue entry:**
`WAITING → READY` (allocation) `→ CHECKED_OUT` (checkout) `→ RETURNED` (return).
Alternatives from `READY`: `EXPIRED` (reservation expiry) or back to `WAITING`
(HOLD). `CANCELLED` is reserved for the CANCEL command (Ticket 5). Terminal
states: `CHECKED_OUT`→`RETURNED`, `CANCELLED`, `EXPIRED`, `RETURNED`.

**Reservation:** `ACTIVE →` one of `CLAIMED` (checkout), `DEFERRED` (HOLD),
`EXPIRED` (expiry), `CANCELLED`.

**Rental:** `OUT → RETURNED`. There is **no mutable LATE status**. "Currently
late" is derived at read time (`due_at < now()`); `was_late` is the frozen
outcome recorded at return.

## Key constraints & invariants

- Durations positive: `sessions.rental_duration_minutes > 0`,
  `pickup_window_minutes > 0`.
- Bin number unique per session: `unique (session_id, bin_number)`.
- **Phone numbers are stored normalized**, enforced by
  `check (phone = public.normalize_phone(phone))` on both `students` and
  `queue_entries`. This makes normalized-phone uniqueness a storage invariant
  rather than a convention each writer must remember, so `(404) 555-0123` and
  `+14045550123` cannot both exist. A composite FK
  `(student_id, phone) → students (id, phone)` keeps the denormalized copy on
  `queue_entries` from drifting from its student.
- **One active queue entry per phone per session**: partial unique index on
  `(session_id, phone) where status in ('WAITING','READY','CHECKED_OUT')`.
- **Session-consistent relationships**: every table carrying a `session_id`
  references its parents by composite key (`(id, session_id)` targets), so a
  queue entry, reservation, rental, or outbox row can never reference a
  student, bin, or entry belonging to a different session.
- Every rental records `panthercard_collected_at` (`not null`).
- **Pickup code unique among active READY entries**: partial unique index on
  `(session_id, pickup_code) where status = 'READY'`; format `^[0-9]{4}$`.
- READY entries must carry `pickup_code`, `reserved_bin_id`, and
  `pickup_expires_at` (check constraint).
- **At most one ACTIVE reservation per bin** and **per queue entry**: two
  partial unique indexes.
- **At most one OUT rental per bin**: partial unique index.
- RETURNED rentals must have `returned_at` and `panthercard_returned_at`
  (check constraints) — a normally completed return records the PantherCard.
- Checkout/return idempotency keys are uniquely indexed on `rentals`.

## Transaction boundaries & locking

Each RPC is one transaction (a single RPC call). Every mutation first takes a
**transaction-scoped advisory lock keyed by session id**
(`public.lock_session` → `pg_advisory_xact_lock(hashtextextended(session_id))`).

- Xact-scoped: released automatically at commit/rollback.
- Re-entrant: nested helper calls (`allocate_bins`, etc.) re-acquire the same
  key safely within the same transaction.
- Effect: all operations **within one session** serialize, so queue order
  cannot be corrupted and a bin cannot be double-assigned; operations in
  **different sessions** proceed concurrently.

Row-level `FOR UPDATE` locks and the partial unique indexes above are defense
in depth: even without the advisory lock, the unique indexes make a double
rental/reservation impossible.

## Idempotency

- **checkout / return**: carry an idempotency key persisted on `rentals`
  (`checkout_idempotency_key` / `return_idempotency_key`, uniquely indexed).
  A missing or blank key is rejected (`IDEMPOTENCY_KEY_REQUIRED`) before any
  state changes, and `rentals_returned_has_idem_key` guarantees a RETURNED
  rental always carries one, so a return stays recognizable on retry.
  Each key is bound to a **request fingerprint** stored alongside it
  (`checkout_request_fingerprint` = session + pickup code + bin number;
  `return_request_fingerprint` = session + bin number). Replay is only valid
  when the key _and_ the fingerprint match — it then returns the original
  rental with `idempotent_replay: true` and performs no new side effects. A key
  reused with different arguments, or in a different session, raises
  `IDEMPOTENCY_CONFLICT` instead of replaying an unrelated result.
- **PantherCard confirmation** is checked with `is distinct from true`, so a
  NULL confirmation is rejected. (`not NULL` evaluates to NULL under SQL
  three-valued logic and would silently fall through.)
- **expire_reservations**: naturally idempotent — it only acts on `ACTIVE`
  reservations whose `expires_at <= now()`. A second run finds none.
- **notification creation**: every insert into `notification_outbox` uses a
  deterministic `dedupe_key` with `on conflict (dedupe_key) do nothing`
  (`INITIAL:<entry>`, `READY:<reservation>`, `HOLD:<reservation>`).

## Queue ordering

- Waiting entries are ordered by `(queue_rank, joined_at, id)` — `id` is the
  stable final tie-breaker.
- After every allocation/HOLD, `reindex_waiting_ranks` reassigns contiguous
  `1..n` ranks to the WAITING set, so ranks never develop gaps.
- Allocation is FIFO: the earliest-ranked WAITING entry is offered the next
  bin.

### HOLD semantics

A student may HOLD an active reservation once. HOLD defers their reservation,
promotes the first waiting student into it (new reservation + new pickup code),
and returns the holder to the waitlist at **actual position two** among the
remaining waiters (or position one if none remain). Example: A reserved with B,
C, D waiting → A holds → B becomes READY, waitlist becomes **C, A, D**. A second
HOLD, or a HOLD with nobody waiting, is rejected. A HOLD racing a checkout or an
expiry produces exactly one valid outcome because both contend for the same
session advisory lock and re-check preconditions.

## Estimated-wait calculation

Informational only; never feeds back into queue order. Implemented
authoritatively in SQL (`public.estimated_wait_minutes`) and mirrored for unit
testing in `src/lib/queue/estimated-wait.ts`.

For every active OUT rental, `expected_return_at = due_at`. Sort those due
times ascending (tie-break by `id`). For a waiting student at 1-based position
`p` with `n` active OUT rentals:

```
cycle   = floor((p - 1) / n)
index   = (p - 1) mod n
minutes = max(0, ceil((sorted_due_times[index] - now) / 60s))
          + cycle * rental_duration
```

The current cycle's remaining time is clamped to zero **before** whole
rental-duration cycles are added. An overdue rental therefore contributes zero
remaining minutes for its own cycle without erasing the later cycles a student
further back must still wait through. (Adding cycles to the historical due
timestamp and clamping afterwards reports 0 minutes for _every_ position behind
a long-overdue rental — e.g. one rental 120 minutes overdue with a 60-minute
duration must yield 0, 60, 120 for positions 1–3, not 0, 0, 0.)

When `n = 0` there is no basis for an estimate, so the
function returns a **clearly-typed unavailable** result (`NULL` in SQL;
`{ available: false }` in TypeScript) rather than inventing a time. When a bin
is AVAILABLE the engine allocates it instead of leaving the student waiting.

## Views

All views are `security_invoker` (RLS on base tables is enforced against the
caller; only the service role reads the data) and use database time for
"currently late" — never a stored status.

| View                     | Contents                                              |
| ------------------------ | ----------------------------------------------------- |
| `v_current_out_rentals`  | Rentals currently OUT, with `is_currently_late`.      |
| `v_current_late_rentals` | OUT rentals past due right now (`due_at < now()`).    |
| `v_all_late_rentals`     | Currently late **or** returned late (history).        |
| `v_inventory`            | Every bin with status and current occupant/late flag. |
| `v_session_rentals`      | All rentals in a session (full history).              |
| `v_current_waitlist`     | WAITING entries ordered by rank.                      |

## Testing strategy

Two complementary integration layers:

- **PGlite (`tests/integration/pglite-*`) — always runs.** Applies the real
  migrations into an in-process PostgreSQL, so schema, constraints, and every
  queue-engine function are genuinely executed. The database is rebuilt from
  the migrations at the start of each run. Being single-connection, it proves
  _logic_ and _guards_, not lock timing.
- **Real PostgreSQL (`tests/integration/queue-engine.test.ts`,
  `concurrency.test.ts`) — requires `DATABASE_URL`.** Multi-connection proofs
  that cannot be simulated: the concurrency suite holds
  `public.lock_session(...)` open in one transaction and asserts that
  checkout / return / HOLD dispatched on _other_ connections genuinely
  **block** until it is released (and that an unrelated session does not
  block). It also forces both HOLD-wins and expiration-wins orderings
  explicitly rather than relying on scheduler luck.

Set **`REQUIRE_DB=1`** to make the real-PostgreSQL suites mandatory: without a
connection string they fail loudly instead of skipping, so CI cannot report a
green run that never exercised true concurrency.

```bash
npx supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  REQUIRE_DB=1 npm run test:integration
```

`DATABASE_URL` may point at any PostgreSQL 14+ server with the migrations
applied — Supabase local is convenient but not required (see the README for a
Docker-free standalone-server recipe, needed on Windows Home where Docker
Desktop cannot run without WSL2).

**The lock proofs are mutation-tested.** Deleting
`perform public.lock_session(p_session_id);` from `public.checkout` makes
"blocks checkout on another connection until the lock is released" and "two
simultaneous checkouts cannot create duplicate rentals" fail. The suite
therefore detects a removed or inconsistently-keyed advisory lock rather than
passing because operations happened to run sequentially.

## Security foundation (and what remains for Ticket 6)

- **RLS is enabled on every application table with no policies** → anon /
  authenticated are denied by default; only the service-role key (trusted
  server operations) bypasses RLS.
- **No broad anonymous read/write policies** exist.
- Every `SECURITY DEFINER` function sets a **fixed empty `search_path`** and
  schema-qualifies all references.
- The default `PUBLIC` execute grant on functions is **revoked**; only
  `service_role` may call the RPCs.
- The service-role key is never exposed to the browser (`server-only` modules,
  no `NEXT_PUBLIC_` prefix — enforced in `src/lib/supabase/`).

**Deferred to Ticket 6:** scoped RLS policies for staff/admin surfaces
(student PII visible only to authorized roles), admin authentication, staff
link/access-code verification, session-code validation, rate limiting, and
column-level encryption / retention for student personal data.
