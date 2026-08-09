# Panther Carts

Cart rental queue management for staffed sessions: students sign up through a
session link and interact via SMS, staff run checkout and return, and admins
control sessions, bins, and live tables.

Built with Next.js (App Router), TypeScript, Tailwind CSS, Supabase
PostgreSQL, Zod, Vitest, and Playwright. Vercel-compatible.

## Documentation

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — authoritative product requirements
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layer boundaries
- [`docs/TICKETS.md`](docs/TICKETS.md) — implementation sequence
- [`docs/DATABASE.md`](docs/DATABASE.md) — schema, queue engine, locking, and estimated-wait design

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in values; never commit credentials
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script                     | Purpose                          |
| -------------------------- | -------------------------------- |
| `npm run dev`              | Development server               |
| `npm run build`            | Production build                 |
| `npm run start`            | Serve the production build       |
| `npm run typecheck`        | TypeScript check                 |
| `npm run lint`             | ESLint                           |
| `npm run format`           | Prettier (write)                 |
| `npm run format:check`     | Prettier (check only)            |
| `npm run test:unit`        | Vitest unit tests (`tests/unit`) |
| `npm run test:integration` | Vitest integration tests         |
| `npm run test:e2e`         | Playwright end-to-end tests      |

Before running `npm run test:e2e` for the first time, install the browser
binary Playwright drives:

```bash
npx playwright install chromium
```

### Database tests

The database suites run against a real PostgreSQL server — **no Docker
required**. One command sets everything up and runs them:

```bash
npm run test:db
```

On the first run this downloads a pinned PostgreSQL 16.4 (~320 MB, once) into
the git-ignored `.localdb/`, creates a cluster, applies the migrations, and runs
the full integration + concurrency suite with `REQUIRE_DB=1`.

| Script              | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `npm run db:start`  | Start the local server (idempotent)            |
| `npm run db:stop`   | Clean shutdown                                 |
| `npm run db:reset`  | Recreate the test database from the migrations |
| `npm run db:status` | Show server and database state                 |
| `npm run test:db`   | Start + reset + run the real-PostgreSQL suite  |

The PGlite suites in `npm run test:integration` always run in-process with no
server. The multi-connection concurrency suites need the real server; setting
`REQUIRE_DB=1` makes them fail loudly rather than skip, so CI cannot go green
without them.

Port conflicts, stale PID files, changing the port, and using an existing
PostgreSQL install are covered in
[`docs/LOCAL_DATABASE.md`](docs/LOCAL_DATABASE.md).
