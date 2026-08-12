# Panther Carts — Architecture

Five layers with strict boundaries. Data flows UI → server operations →
queue logic / database operations, with SMS as a server-side effect.

## 1. UI (React components and pages)

- Location: `src/app/**`, `src/components/{student,staff,admin}/`
- Renders state and collects input. Client components may subscribe to
  Supabase Realtime for live table updates (admin dashboard) — read-only.
- **Never contains authoritative queue mutations.** No queue ordering,
  HOLD transfers, reservation assignment, or rental state transitions may be
  computed or persisted from a React component. Components only call server
  operations.
- Browser code may import `src/lib/supabase/client.ts` only.

## 2. Server operations (server actions and route handlers)

- Location: server actions and `src/app/api/**` route handlers, including
  provider-specific signed SMS webhooks and the authenticated internal outbox
  worker trigger.
- The only entry points for state changes. Each operation validates input
  with Zod schemas from `src/lib/validation/`, checks authorization
  (`src/lib/auth/`), invokes queue logic, persists via database operations,
  and triggers SMS side effects.
- Concurrency-sensitive operations (signup, HOLD, checkout, return) must be
  atomic — a single transaction or database function per operation.

## 3. Database operations (Supabase)

- Location: `src/lib/supabase/`, schema in `supabase/migrations/`.
- The authoritative queue engine lives here as PostgreSQL functions
  (`supabase/migrations/`, Ticket 1), invoked via Supabase RPC — see layer 4
  and `docs/DATABASE.md`.
- Three clients, chosen by trust level:
  - `client.ts` — browser client, anon key, public env vars only.
  - `server.ts` — server client with request cookies; `server-only`.
  - `admin.ts` — service-role client; `server-only`; bypasses RLS; used
    only by trusted server operations.
- The service-role key (`SUPABASE_SERVICE_ROLE_KEY`) is never exposed to
  the browser: it has no `NEXT_PUBLIC_` prefix and lives only in modules
  guarded by the `server-only` package, so a client-side import fails the
  build.
- Supabase Realtime is used only where it adds value (live admin tables,
  staff queue view) — never as a mutation path.

## 4. Queue logic

- Authoritative logic: PostgreSQL functions in `supabase/migrations/`
  (Ticket 1), invoked via Supabase RPC. Position assignment, allocation, HOLD
  transfer, checkout, return, and reservation expiration are atomic,
  idempotent, and serialized per session by a transaction-scoped advisory
  lock. This keeps every queue-order and bin-assignment decision inside a
  single transaction, so it cannot be corrupted by concurrency and cannot be
  computed from a React component. See `docs/DATABASE.md`.
- `src/lib/queue/` holds the server-side surface of that engine: the
  deterministic estimated-wait mirror (`estimated-wait.ts`, unit-tested), the
  domain error tokens (`errors.ts`), and — in later tickets — thin RPC
  wrappers called by server operations. It never persists queue state from the
  browser.
- Server operations (and SMS handlers) are the only callers. Estimated wait is
  informational and never feeds back into queue order.
- Tests: pure mirrors in `tests/unit`; database integration/concurrency
  coverage in `tests/integration` against a local Supabase instance.

## 5. SMS

- Location: `src/lib/sms/` and provider routes under `src/app/api/sms/`.
- Provider-independent: application code depends on `SmsProvider`; Telnyx and
  Twilio adapters contain all concrete HTTP and signature behavior. Server-only
  selection validates credentials only for the one `SMS_PROVIDER`. There is no
  automatic failover because a cross-provider retry can duplicate messages and
  violate compliance behavior.
- Telnyx verifies the Ed25519 signature over the exact raw body and timestamp
  before JSON parsing. Twilio verifies `X-Twilio-Signature` against the exact
  configured public URL and every form parameter before trusted parsing.
- Panther Carts commands are exactly TIME, HOLD, and CANCEL. HELP, STOP, and
  START/UNSTOP are carrier-compliance keywords. Provider classifications are
  acknowledged without a queue mutation or duplicate response. A provider
  classification attached to an application command records
  `COMPLIANCE_OVERRODE_COMMAND` so Advanced Opt-Out mistakes are detectable.
- `handle_inbound_sms` records the provider-scoped event/message identifier,
  resolves the normalized sender to one active lifecycle, executes the
  authoritative mutation, and enqueues its response in one transaction.
- Outbound delivery claims `notification_outbox` rows with `FOR UPDATE SKIP
LOCKED`, a claim token, and an expiring lease. Provider HTTP requests have a
  shorter deadline than the lease, and rejected completion tokens are surfaced
  as unconfirmed. Provider failures are reduced to safe retry classes.
  Credentials, raw signatures, phone numbers, message bodies, and provider
  error bodies are never logged.
- The worker guard rejects Unicode and multi-segment normal templates. The
  provider network boundary cannot be perfectly exactly-once: a process crash
  after send acceptance and before the SENT commit can be retried after lease
  expiry.

## Testing boundaries

- `tests/unit` — queue logic, validation schemas, SMS commands, GSM analysis,
  provider adapters/signatures, and outbox worker behavior (Vitest).
- `tests/integration` — server operations against a database, concurrency
  cases (Vitest).
- `tests/e2e` — full browser flows (Playwright).
