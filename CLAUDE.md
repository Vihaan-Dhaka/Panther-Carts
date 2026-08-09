# Panther Carts — Instructions for Claude Code

## Required reading

Before making any product change, read `docs/PRODUCT_SPEC.md` in full. It is
the authoritative requirements document. Also consult `docs/ARCHITECTURE.md`
for layer boundaries and `docs/TICKETS.md` for work sequencing.

## Hard rules

- **Never put authoritative queue mutations inside React components.**
  Queue ordering, HOLD transfers, reservation assignment, and rental state
  transitions live in `src/lib/queue/` and are invoked only from server
  operations (server actions / route handlers). Components call server
  operations; they never compute or persist queue state.
- Never import `src/lib/supabase/server.ts` or `src/lib/supabase/admin.ts`
  from client components. Both are `server-only`. Browser code uses
  `src/lib/supabase/client.ts` exclusively.
- Never commit credentials. `.env.example` holds variable names only.
  `SUPABASE_SERVICE_ROLE_KEY` must never get a `NEXT_PUBLIC_` prefix.
- Application code depends on the `SmsProvider` interface
  (`src/lib/sms/types.ts`), never on a concrete SMS provider SDK.
- Validate all external input with Zod schemas from `src/lib/validation/`.
- Never force-push.

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint
- `npm run format` / `npm run format:check` — Prettier
- `npm run test:unit` — Vitest unit tests (`tests/unit`)
- `npm run test:integration` — Vitest integration tests (`tests/integration`)
- `npm run test:e2e` — Playwright (`tests/e2e`)

Run typecheck, lint, and the relevant tests before considering a change
done.
