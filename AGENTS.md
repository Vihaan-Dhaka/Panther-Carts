<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Panther Carts — Codex Implementation Instructions

## Role

Codex is the implementation agent. It may inspect, plan, edit, test, and
document ticket work. Follow the lifecycle in
[`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md): every ticket
starts from an updated `main` on its own branch, and Codex must never work
directly on `main`.

Before implementation, read the applicable ticket in `docs/TICKETS.md` and the
relevant sections of the authoritative references:

- `docs/PRODUCT_SPEC.md` — product requirements.
- `docs/ARCHITECTURE.md` — layer boundaries.
- `docs/DATABASE.md` — data model, invariants, and database testing.

Consult any additional repository documentation relevant to the ticket. Do
not copy the product specification into this file.

## Implementation responsibilities

- Preserve unrelated user changes. Do not discard, rewrite, or include them in
  ticket commits.
- Add regression tests for every behavior changed by the ticket.
- Run every check relevant to the ticket. When database behavior is affected,
  this includes the real PostgreSQL suite via `npm run test:db`; a run that
  skips the database-dependent tests is not sufficient.
- Commit and push only to the ticket branch. Never force-push.
- Codex may open or update a pull request into `main`, but must never merge it.
- Only one agent writes code at a time. Claude audits the resulting pull request
  read-only.

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

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint
- `npm run format` / `npm run format:check` — Prettier
- `npm run test:unit` — Vitest unit tests (`tests/unit`)
- `npm run test:integration` — Vitest integration tests (`tests/integration`)
- `npm run test:e2e` — Playwright (`tests/e2e`)
- `npm run db:start` — start the local PostgreSQL server
- `npm run db:stop` — stop the local PostgreSQL server
- `npm run db:reset` — recreate the local database and apply migrations
- `npm run db:status` — show local PostgreSQL status and connection details
- `npm run test:db` — reset and run the real-PostgreSQL test suite

Run typecheck, lint, and the relevant tests before considering a change
done.

## Required handoff

Codex's final ticket handoff must include:

- Branch name and commit hash.
- Files changed.
- Behavior implemented.
- Tests run with exact pass, fail, and skip counts.
- Any tests not run or skipped, with the reason.
- Known risks.
- Manual configuration still required.
