# Panther Carts — Development Workflow

This repository uses Codex to implement tickets and Claude to audit them
independently. The authoritative requirements remain in
[`PRODUCT_SPEC.md`](PRODUCT_SPEC.md), [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`DATABASE.md`](DATABASE.md), and [`TICKETS.md`](TICKETS.md).

## Ticket lifecycle

1. The user selects the ticket.
2. Codex updates `main`, creates the ticket branch, and switches to it.
3. Codex implements the ticket and adds and runs the relevant tests.
4. Codex commits, pushes, and opens a pull request into `main` without merging.
5. Claude audits the full pull request read-only.
6. If Claude reports findings, they return to the same Codex task.
7. Codex fixes the merge-blocking findings and any accepted suggestions,
   retests, commits, and pushes to the same branch.
8. Claude re-audits the complete updated pull request. Repeat steps 6–8 until
   no merge-blocking findings remain. If the first audit is clean, proceed
   directly to step 9.
9. The user merges only after Claude approves the ticket for merge.
10. Only one agent writes code at a time.

Codex never implements directly on `main`, and neither agent merges the pull
request. Claude does not modify code or application/database state while acting
as the audit agent.

## Branch naming

- `feature/ticket-N-short-description` — product functionality.
- `fix/ticket-N-short-description` — ticket-scoped defect correction.
- `chore/short-description` — workflow, tooling, or maintenance work.

Use a fresh branch from the latest `main` for every ticket. Subsequent fixes
from review stay on that same ticket branch and pull request.

## Standard commands

- `npm run dev` — development server.
- `npm run build` — production build.
- `npm run typecheck` — TypeScript check.
- `npm run lint` — ESLint.
- `npm run format` / `npm run format:check` — write or verify formatting.
- `npm run test:unit` — unit tests.
- `npm run test:integration` — integration tests.
- `npm run test:e2e` — end-to-end tests.

Before using the local PostgreSQL commands below, read
[`LOCAL_DATABASE.md`](LOCAL_DATABASE.md) for their download, platform,
configuration, and safety prerequisites.

- `npm run db:start` — start the local PostgreSQL server.
- `npm run db:stop` — stop the local PostgreSQL server.
- `npm run db:reset` — recreate the local database and apply migrations.
- `npm run db:status` — show local PostgreSQL status and connection details.
- `npm run test:db` — reset and run the real-PostgreSQL test suite.

Select checks based on the ticket's scope. Database behavior always requires
the real PostgreSQL suite in addition to other relevant checks.

## Handoffs and audits

Codex's handoff records the branch, commit hash, changed files, implemented
behavior, exact test counts, skipped tests, known risks, and remaining manual
configuration. Claude reviews the complete pull request and reports findings
in severity order, separating merge-blocking defects from non-blocking
suggestions. Each finding identifies the exact file and line, failing scenario,
impact, and required correction.
