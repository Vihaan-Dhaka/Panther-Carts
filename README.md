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

## SMS deployment configuration

Set `SMS_PROVIDER` to exactly `telnyx` (recommended) or `twilio`; configure only
that provider's credentials plus a local 10DLC `SMS_FROM_NUMBER`. Never commit
values from `.env.local`.

- Telnyx webhook: `https://YOUR-DOMAIN/api/sms/telnyx`
- Twilio webhook: `https://YOUR-DOMAIN/api/sms/twilio`
- Authenticated worker: `POST https://YOUR-DOMAIN/api/internal/sms-outbox`
  with `Authorization: Bearer $SMS_OUTBOX_WORKER_SECRET`

Telnyx requires `TELNYX_API_KEY` and the account Ed25519
`TELNYX_PUBLIC_KEY`. Twilio requires `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, and
`TWILIO_WEBHOOK_URL`; that URL must exactly match the public webhook URL Twilio
signs, including any query string.

Before production, manually assign the local 10DLC number and webhook to the
selected provider profile/service and complete 10DLC registration. Enable
Advanced Opt-Out and remove `CANCEL` from opt-out keywords while retaining
provider-managed STOP, START/UNSTOP, and HELP responses. Panther Carts uses
`CANCEL` to leave its queue; it is not an SMS opt-out. Do not use a toll-free
number for this flow.

Provider setup references:

- [Telnyx API v2 send](https://developers.telnyx.com/api-reference/messages/send-a-message),
  [signed inbound webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks),
  and [Advanced Opt-In/Out](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out)
- [Twilio message API](https://www.twilio.com/docs/messaging/api/message-resource),
  [webhook signatures](https://www.twilio.com/docs/usage/webhooks/webhooks-security),
  and [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out)

The outbox worker uses atomic claims, expiring leases, five bounded attempts,
and retry backoff. Schedule the authenticated POST at least once per minute.
A rare duplicate remains possible if a provider accepts a message and the
worker crashes before the SENT state commits; no distributed system can make
that network boundary perfectly exactly-once without provider idempotency.
