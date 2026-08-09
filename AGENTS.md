<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Panther Carts — Instructions for Codex

## Required reading

Before making any product change, read `docs/PRODUCT_SPEC.md` in full. It is
the authoritative requirements document. Also consult `docs/ARCHITECTURE.md`
for layer boundaries and `docs/TICKETS.md` for work sequencing.

## Hard rules

- **Never put authoritative queue mutations inside React components.**
  Queue ordering, HOLD transfers, reservation assignment, and rental state
  transitions are PostgreSQL functions in `supabase/migrations/`, invoked via
  Supabase RPC only from server operations (server actions / route handlers);
  `src/lib/queue/` holds their server-side wrappers and pure helpers (e.g. the
  estimated-wait mirror in `estimated-wait.ts`). Components call server
  operations; they never compute or persist queue state. See `docs/DATABASE.md`.
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
