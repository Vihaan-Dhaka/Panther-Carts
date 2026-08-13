# Local database (no Docker)

The database tests need a real PostgreSQL server. Docker Desktop cannot run on
Windows Home — it has no Hyper-V and requires a WSL2 backend — so
`supabase start` is unavailable there. Nothing in Ticket 1 actually needs the
full Supabase stack: the suites only need PostgreSQL with the migrations
applied, so `scripts/db.mjs` manages a private, pinned server instead.

- **PostgreSQL version:** **16.4** (pinned in `scripts/db.mjs` as `PG_VERSION`)
- **Location:** `.localdb/` in the repo root — git-ignored, never committed
  - `.localdb/postgresql-16.4/pgsql/bin` — the server binaries
  - `.localdb/data` — the cluster (your database contents)
  - `.localdb/postgres.log` — server log, the first place to look on failure
- **Default port:** `55432` (not 5432, so it cannot collide with an existing
  PostgreSQL install)
- **Test database:** `panther_test`

Binaries and cluster data are downloaded/created on your machine and are
git-ignored. No binaries, database contents, or credentials are committed.

## Commands

| Command             | What it does                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run db:start`  | Start the server. Downloads PostgreSQL on first run, creates the cluster if needed. Safe to run repeatedly. |
| `npm run db:stop`   | Clean shutdown (`pg_ctl -m fast`). Safe if already stopped.                                                 |
| `npm run db:reset`  | Drop and recreate `panther_test`, then apply every `supabase/migrations/*.sql` in order.                    |
| `npm run db:status` | Report binaries, version, data directory, server state, and whether the test database exists.               |
| `npm run test:db`   | Start if needed → reset → run the full integration + concurrency suite with `REQUIRE_DB=1`.                 |

`npm run test:db` is the one to remember; the others are for when something
needs attention.

## First-time setup

```bash
npm run test:db
```

That is the whole thing. On the first run it downloads PostgreSQL 16.4
(~320 MB, once), extracts it to `.localdb/`, initializes a cluster, applies the
migrations, and runs the suite. Subsequent runs skip straight to resetting and
testing.

The server keeps running after the command finishes so repeat runs are fast.
Stop it with `npm run db:stop` when you are done for the day.

## Authentication

The cluster is created with `--auth=trust` and listens on `127.0.0.1` only. It
is a disposable local test cluster, so there is no password to manage or leak —
which is also why no credential is ever committed. Do not reuse this cluster
for anything that matters.

## Troubleshooting

### The port is already in use

If something else is already serving PostgreSQL on the port, `db:start` stops
with a clear message rather than producing a confusing failure. Either stop the
other server, or pick a different port (see below).

To find what is holding the port on Windows:

```powershell
Get-NetTCPConnection -LocalPort 55432 | Select-Object OwningProcess
Get-Process -Id <OwningProcess>
```

### Changing the port

Any of these work — the environment variable wins:

```bash
PANTHER_DB_PORT=55433 npm run test:db
```

or create `.env.db.local` in the repo root (git-ignored) so it applies to every
command:

```
PANTHER_DB_PORT=55433
```

`DATABASE_URL` is derived from the port automatically; you do not need to set
it yourself.

### Stale PID file after a crash or hard reboot

If the machine loses power or the process is killed, `postmaster.pid` can be
left behind and PostgreSQL will refuse to start. `db:start` detects this and
removes the file **only** once `pg_ctl` confirms no server is running, then
starts normally. You should just see:

```
[db] removed a stale postmaster.pid left by an unclean shutdown
```

If it still will not start, read the log — it names the real cause:

```bash
tail -30 .localdb/postgres.log
```

### Clean shutdown

```bash
npm run db:stop
```

Uses `-m fast`: active connections are terminated and the shutdown checkpoint
is written, so the next start is clean. Avoid killing the process directly —
that is what leaves stale PID files.

### Resetting the database

```bash
npm run db:reset
```

Drops `panther_test` with `WITH (FORCE)` (so lingering test connections do not
block it), recreates it, and re-applies every migration in filename order.
Use this whenever you change a migration — migrations are **not** applied
incrementally, the database is always rebuilt from scratch.

### The download failed or was interrupted

The partially-downloaded archive is kept at
`.localdb/postgresql-16.4-1.zip`, so retrying does not re-download 320 MB. If
the archive itself is corrupt, delete `.localdb/` and run `npm run db:start`
again for a completely fresh install.

### "could not extract" on Windows

The script tries several extractors in order. Note that the `tar` first on
PATH is often Git's **GNU tar**, which cannot read zip archives — so the
Windows-native bsdtar at `C:\Windows\System32\tar.exe` is tried first, with
`unzip` and PowerShell `Expand-Archive` as fallbacks. The error message lists
what each attempt reported.

### Using an existing PostgreSQL instead (macOS/Linux, or a system install)

Automatic download only covers Windows. Point the script at any PostgreSQL 14+
`bin` directory:

```bash
export PANTHER_PG_BIN=/opt/homebrew/opt/postgresql@16/bin
npm run test:db
```

Everything else (cluster creation, reset, migrations) works the same.

### Running the suite against a completely different database

The tests only care about `DATABASE_URL`, so any PostgreSQL with the migrations
applied works — including Supabase local if you do have Docker:

```bash
npx supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  REQUIRE_DB=1 npm run test:integration
```

`REQUIRE_DB=1` makes the real-PostgreSQL suites fail loudly instead of skipping,
so a green run can never mean "the important tests were silently skipped".

## What runs where

- **PGlite suites** (`tests/integration/pglite-*`) always run, in-process, with
  no server — they rebuild the schema from the real migrations. Single
  connection, so they prove logic and constraints, not lock timing.
- **Real-PostgreSQL suites** (`queue-engine.test.ts`, `concurrency.test.ts`, and
  `sms-concurrency.test.ts`) need this server. They prove the session advisory
  locks and outbox row locks genuinely block or skip concurrent transactions,
  which cannot be simulated in-process.

See `docs/DATABASE.md` for the schema, locking, and idempotency design.
