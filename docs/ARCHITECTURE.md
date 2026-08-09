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

- Location: server actions and `src/app/api/**` route handlers.
- The only entry points for state changes. Each operation validates input
  with Zod schemas from `src/lib/validation/`, checks authorization
  (`src/lib/auth/`), invokes queue logic, persists via database operations,
  and triggers SMS side effects.
- Concurrency-sensitive operations (signup, HOLD, checkout, return) must be
  atomic — a single transaction or database function per operation.

## 3. Database operations (Supabase)

- Location: `src/lib/supabase/`, schema in `supabase/migrations/`.
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

- Location: `src/lib/queue/` (Ticket 1).
- Pure, deterministic functions covering position assignment, HOLD
  transfer, cancellation, and estimated-wait calculation as specified in
  `docs/PRODUCT_SPEC.md`. Pure functions take current state and return the
  next state, making the spec's rules (e.g. the HOLD example: A holds →
  B gets the reservation, waitlist becomes C, A, D) directly unit-testable.
- Server operations are the only callers. Estimated wait is informational
  and never feeds back into queue order.

## 5. SMS

- Location: `src/lib/sms/`.
- Provider-independent: application code depends on the `SmsProvider`
  interface (`types.ts`); Telnyx and Twilio adapters implement it in
  Ticket 5, selected via `SMS_PROVIDER`.
- Outbound messages are sent by server operations after state changes.
- Inbound commands (TIME, HOLD, CANCEL, HELP) arrive at a webhook route
  handler, are verified and parsed by the provider adapter, validated, and
  dispatched to the same server operations the UI uses — SMS is an
  alternative entry point, not a separate logic path.

## Testing boundaries

- `tests/unit` — queue logic, validation schemas, SMS command parsing
  (pure functions, Vitest).
- `tests/integration` — server operations against a database, concurrency
  cases (Vitest).
- `tests/e2e` — full browser flows (Playwright).
