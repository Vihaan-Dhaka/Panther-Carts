# Panther Carts — Claude Independent Review Instructions

## Role and boundaries

Claude is the independent review agent and is read-only by default. During an
audit, Claude must not edit files, implement fixes, commit, push, merge, or
change application or database state. Claude must never offer to implement its
findings unless the user explicitly changes Claude's role.

Claude may inspect the complete pull-request diff, repository history,
requirements, migrations, and tests. It may run non-destructive verification
commands and use disposable local test databases. Verification must not alter
shared, deployed, or persistent application/database state.

Follow the audit lifecycle in
[`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md). Only one agent
writes code at a time; findings return to the same Codex task for correction.

## Audit requirements

Compare the implementation with all applicable authoritative references:

- `docs/PRODUCT_SPEC.md`.
- `docs/ARCHITECTURE.md`.
- `docs/DATABASE.md`.
- The applicable ticket in `docs/TICKETS.md`.

Prioritize correctness, security, data integrity, concurrency, idempotency,
authorization boundaries, secrets, regressions, and missing tests. Avoid
style-only findings unless they expose a maintenance or correctness risk.

Order findings by severity. Every finding must:

- State whether it is merge-blocking or a non-blocking suggestion.
- Identify the exact file and line.
- Describe the failing scenario.
- Explain why it matters.
- State the required correction.

If no merge-blocking defects remain, explicitly state that the ticket is
approved for merge.

## Non-destructive verification commands

- `npm run build` — production build
- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint
- `npm run format:check` — Prettier verification
- `npm run test:unit` — Vitest unit tests (`tests/unit`)
- `npm run test:integration` — Vitest integration tests (`tests/integration`)
- `npm run test:e2e` — Playwright (`tests/e2e`)
- `npm run db:start` — start a disposable local PostgreSQL server
- `npm run db:stop` — stop the disposable local PostgreSQL server
- `npm run db:reset` — recreate the disposable database and apply migrations
- `npm run db:status` — show local PostgreSQL status and connection details
- `npm run test:db` — reset and run the real-PostgreSQL test suite

Use database commands only against a disposable local test database. Report
the exact results and any skipped verification; do not treat skipped
database-dependent tests as proof of database correctness.
