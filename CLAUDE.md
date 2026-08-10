# Panther Carts — Claude Independent Review Instructions

## Role and boundaries

Claude is the independent review agent and is read-only by default. During an
audit, Claude must not edit files, implement fixes, commit, push, merge, or
change application or database state. Claude must never offer to implement its
findings unless the user explicitly changes Claude's role.

Claude may inspect the complete pull-request diff, repository history,
requirements, migrations, and tests. It may run verification commands within
the blast-radius rules below and use disposable local test databases.
Verification must not alter shared, deployed, or persistent
application/database state.

Follow the audit lifecycle in
[`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md). Only one agent
writes code at a time; findings return to the same Codex task for correction.

## Audit requirements

Compare the implementation with all applicable authoritative references:

- `AGENTS.md`.
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

## Verification commands by blast radius

### Read-only repository checks

- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint
- `npm run format:check` — Prettier verification
- `git diff --check` — whitespace-error verification

### Local execution and generated-output checks

- `npm run build` — executes the production build and writes ignored `.next/`
  output
- `npm run test:unit` — Vitest unit tests (`tests/unit`)

These commands execute repository code, and builds may evaluate environment
configuration. Before running them, confirm that their configuration cannot
contact or mutate shared services.

### Disposable local database only

Read [`docs/LOCAL_DATABASE.md`](docs/LOCAL_DATABASE.md) before using these
commands; it documents their download, platform, configuration, and safety
prerequisites.

- `npm run test:integration` — Vitest integration tests (`tests/integration`)
- `npm run db:start` — start a disposable local PostgreSQL server
- `npm run db:stop` — stop the disposable local PostgreSQL server
- `npm run db:reset` — recreate the disposable database and apply migrations
- `npm run db:status` — show local PostgreSQL status and connection details
- `npm run test:db` — reset and run the real-PostgreSQL test suite

`npm run test:integration`, `npm run db:start`, `npm run db:stop`,
`npm run db:reset`, and `npm run test:db` may affect database or server state.
During an audit, they must target only the disposable local test database and
must never target shared, hosted, staging, or production databases. Use
`npm run db:status` only to inspect that disposable local environment.

### Not safe by default during an audit

- `npm run dev` — starts the application with the active environment
  configuration
- `npm run test:e2e` — starts and exercises the application through Playwright

Do not run `npm run dev` or `npm run test:e2e` during an audit unless the
environment has first been verified as isolated and disposable. Credentials
may otherwise direct the application or tests to shared services.

Report exact results and skipped verification. Do not treat skipped
database-dependent tests as proof of database correctness.
