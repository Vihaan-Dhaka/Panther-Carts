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

### Database integration tests

`npm run test:integration` exercises the SQL queue engine against a local
Supabase database. It requires Docker (for `supabase start`) and a connection
string; without one, the database suites skip cleanly instead of failing.

```bash
npx supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  REQUIRE_DB=1 npm run test:integration
```

The PGlite suites always run (they rebuild the schema from the migrations
in-process). The multi-connection concurrency suites need a real database; set
`REQUIRE_DB=1` to make them mandatory so they cannot silently skip in CI.

**No Docker?** `DATABASE_URL` can point at _any_ PostgreSQL 14+ server — the
tests only need the migrations applied. Docker Desktop cannot run on Windows
Home without WSL2, so a standalone server (including the portable
`postgresql-*-windows-x64-binaries.zip`, which needs no installer or admin)
works just as well:

```bash
# one-time: initdb -D <data> -U postgres --auth=trust && pg_ctl -D <data> -o "-p 55432" start
createdb -h 127.0.0.1 -p 55432 -U postgres panther_test
for f in supabase/migrations/*.sql; do
  psql -h 127.0.0.1 -p 55432 -U postgres -d panther_test -v ON_ERROR_STOP=1 -f "$f"
done
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/panther_test \
  REQUIRE_DB=1 npm run test:integration
```
