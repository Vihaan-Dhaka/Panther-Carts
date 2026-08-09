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
  npm run test:integration
```
