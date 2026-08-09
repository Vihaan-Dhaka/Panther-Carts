#!/usr/bin/env node
/**
 * Local PostgreSQL for the Ticket 1 database tests — without Docker.
 *
 * Docker Desktop cannot run on Windows Home (no Hyper-V, and it requires a
 * WSL2 backend), so `supabase start` is unavailable there. The integration and
 * concurrency suites only need a real PostgreSQL server with the migrations
 * applied, so this script manages a private, pinned server instead.
 *
 * Everything lives under .localdb/ (git-ignored): the extracted binaries and
 * the cluster data directory. No binaries, cluster files, or credentials are
 * ever committed.
 *
 * Commands (see package.json):
 *   node scripts/db.mjs start    idempotent; downloads binaries on first run
 *   node scripts/db.mjs stop     clean shutdown (fast mode)
 *   node scripts/db.mjs reset    recreate the test DB and apply migrations
 *   node scripts/db.mjs status   report server + database state
 *   node scripts/db.mjs test     start + reset + run the real-PostgreSQL suite
 *
 * Configuration (all optional):
 *   PANTHER_DB_PORT   server port                 (default 55432)
 *   PANTHER_DB_NAME   test database name          (default panther_test)
 *   PANTHER_DB_HOME   where binaries/data live    (default <repo>/.localdb)
 *   PANTHER_PG_BIN    use an existing PostgreSQL bin/ directory instead of
 *                     downloading (required on macOS/Linux)
 * A git-ignored .env.db.local may set the same KEY=value pairs.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pinned so every machine and CI run uses an identical server build.
const PG_VERSION = "16.4";
const PG_BUILD = "16.4-1"; // EnterpriseDB build tag
const PG_ZIP_URL = `https://get.enterprisedb.com/postgresql/postgresql-${PG_BUILD}-windows-x64-binaries.zip`;

// Bounded waits so a crash loop surfaces as an error instead of hanging.
const START_TIMEOUT_SECONDS = 60;
const STOP_TIMEOUT_SECONDS = 60;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Load .env.db.local (git-ignored) without overriding real environment vars. */
function loadLocalEnv() {
  const file = path.join(REPO_ROOT, ".env.db.local");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadLocalEnv();

const PORT = process.env.PANTHER_DB_PORT ?? "55432";
const DB_NAME = process.env.PANTHER_DB_NAME ?? "panther_test";
const DB_HOME = process.env.PANTHER_DB_HOME
  ? path.resolve(process.env.PANTHER_DB_HOME)
  : path.join(REPO_ROOT, ".localdb");
const PG_ROOT = path.join(DB_HOME, `postgresql-${PG_VERSION}`);
const BIN_DIR = process.env.PANTHER_PG_BIN
  ? path.resolve(process.env.PANTHER_PG_BIN)
  : path.join(PG_ROOT, "pgsql", "bin");
const DATA_DIR = path.join(DB_HOME, "data");
const LOG_FILE = path.join(DB_HOME, "postgres.log");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");

export const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

const bin = (name) => path.join(BIN_DIR, `${name}${EXE}`);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (msg) => console.log(`[db] ${msg}`);

function fail(msg) {
  console.error(`\n[db] ERROR: ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

/** Tail the server log — the useful part of any startup failure. */
function logTail(lines = 15) {
  if (!fs.existsSync(LOG_FILE)) return "(no log file yet)";
  return fs
    .readFileSync(LOG_FILE, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Binaries
// ---------------------------------------------------------------------------

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok)
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const out = fs.createWriteStream(dest);
  let seen = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    seen += chunk.length;
    out.write(chunk);
    if (total) {
      const pct = Math.floor((seen / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(
          `\r[db] downloading PostgreSQL ${PG_VERSION}… ${pct}%`,
        );
      }
    }
  }
  out.end();
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  process.stdout.write("\n");
}

/**
 * Extract a zip using whichever tool is actually available.
 *
 * Order matters. On Windows the `tar` found first on PATH is often Git's GNU
 * tar, which cannot read zip archives at all, so the Windows-native bsdtar in
 * System32 is tried explicitly first. Each candidate is verified by checking
 * for a known file afterwards rather than trusting the exit code, because a
 * partial extraction can still report success.
 */
function extractZip(zipPath, destDir, verifyRelPath) {
  fs.mkdirSync(destDir, { recursive: true });

  const candidates = [];
  if (IS_WINDOWS) {
    candidates.push({
      name: "bsdtar (System32)",
      cmd: path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "tar.exe",
      ),
      args: ["-xf", zipPath, "-C", destDir],
    });
  }
  candidates.push({
    name: "tar",
    cmd: "tar",
    args: ["-xf", zipPath, "-C", destDir],
  });
  candidates.push({
    name: "unzip",
    cmd: "unzip",
    args: ["-q", "-o", zipPath, "-d", destDir],
  });
  if (IS_WINDOWS) {
    candidates.push({
      name: "Expand-Archive",
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
    });
  }

  const errors = [];
  for (const candidate of candidates) {
    const res = run(candidate.cmd, candidate.args);
    if (res.error) {
      errors.push(`${candidate.name}: ${res.error.message}`);
      continue;
    }
    if (fs.existsSync(path.join(destDir, verifyRelPath))) return candidate.name;
    errors.push(
      `${candidate.name}: exit ${res.status}${res.stderr ? ` — ${res.stderr.trim().split(/\r?\n/)[0]}` : ""}`,
    );
  }
  throw new Error(`could not extract ${zipPath}\n  ${errors.join("\n  ")}`);
}

async function ensureBinaries() {
  if (fs.existsSync(bin("pg_ctl"))) return;

  if (process.env.PANTHER_PG_BIN) {
    fail(
      `PANTHER_PG_BIN is set to ${BIN_DIR} but no pg_ctl${EXE} was found there.`,
    );
  }
  if (!IS_WINDOWS) {
    fail(
      `Automatic download only covers Windows. Install PostgreSQL ${PG_VERSION} ` +
        `(e.g. 'brew install postgresql@16' or your package manager) and point this ` +
        `script at it:\n  export PANTHER_PG_BIN=/path/to/postgresql/bin`,
    );
  }

  log(
    `PostgreSQL ${PG_VERSION} not found — fetching a private copy (~320 MB, once)`,
  );
  fs.mkdirSync(DB_HOME, { recursive: true });
  const zipPath = path.join(DB_HOME, `postgresql-${PG_BUILD}.zip`);
  try {
    // Reuse a previously downloaded archive so a failed extraction does not
    // force another 320 MB download.
    if (!fs.existsSync(zipPath)) {
      await download(PG_ZIP_URL, zipPath);
    } else {
      log("reusing the already-downloaded archive");
    }
    log("extracting…");
    const via = extractZip(
      zipPath,
      PG_ROOT,
      path.join("pgsql", "bin", `pg_ctl${EXE}`),
    );
    log(`extracted with ${via}`);
    fs.rmSync(zipPath, { force: true });
  } catch (error) {
    fail(
      `${error.message}\n\nThe archive was kept at ${zipPath} so a retry will not ` +
        `re-download. Delete ${DB_HOME} to start completely fresh.`,
    );
  }
  if (!fs.existsSync(bin("pg_ctl"))) {
    fail(
      `extraction finished but ${bin("pg_ctl")} is missing — delete ${DB_HOME} and retry`,
    );
  }
  log(`PostgreSQL ${PG_VERSION} installed at ${PG_ROOT}`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/** pg_ctl status: 0 = running, 3 = stopped, 4 = no/invalid data directory. */
function serverStatus() {
  if (!fs.existsSync(DATA_DIR)) return "absent";
  const res = run(bin("pg_ctl"), ["-D", DATA_DIR, "status"]);
  if (res.status === 0) return "running";
  return "stopped";
}

/**
 * True when *something* is accepting connections on our port.
 * -U postgres avoids a FATAL "role <os-user> does not exist" line in the server
 * log; the check only cares that the port answers.
 */
function portResponds() {
  const res = run(bin("pg_isready"), [
    "-h",
    "127.0.0.1",
    "-p",
    PORT,
    "-U",
    "postgres",
    "-q",
  ]);
  return res.status === 0;
}

/**
 * A crash can leave postmaster.pid behind; PostgreSQL then refuses to start.
 * Only safe to remove once pg_ctl agrees no server is running.
 */
function clearStalePidFile() {
  const pidFile = path.join(DATA_DIR, "postmaster.pid");
  if (fs.existsSync(pidFile) && serverStatus() !== "running") {
    fs.rmSync(pidFile, { force: true });
    log("removed a stale postmaster.pid left by an unclean shutdown");
  }
}

function initCluster() {
  log(`initializing a new cluster at ${DATA_DIR}`);
  fs.mkdirSync(DB_HOME, { recursive: true });
  // trust auth on loopback only: a local dev cluster with no password to leak.
  const res = run(bin("initdb"), [
    "-D",
    DATA_DIR,
    "-U",
    "postgres",
    "--auth=trust",
    "--encoding=UTF8",
  ]);
  if (res.status !== 0) {
    fail(`initdb failed:\n${res.stderr || res.stdout}`);
  }
}

async function start({ quiet = false } = {}) {
  await ensureBinaries();
  if (!fs.existsSync(DATA_DIR)) initCluster();

  if (serverStatus() === "running") {
    if (!quiet) log(`already running on port ${PORT} (nothing to do)`);
    return;
  }

  clearStalePidFile();

  // Distinguish "our server is down" from "the port belongs to someone else".
  if (portResponds()) {
    fail(
      `port ${PORT} is already serving PostgreSQL, but it is not this cluster.\n` +
        `Stop that server, or choose another port:\n` +
        `  PANTHER_DB_PORT=55433 npm run db:start\n` +
        `(or put PANTHER_DB_PORT=55433 in .env.db.local)`,
    );
  }

  // -t bounds the wait: without it pg_ctl blocks forever if the server enters
  // a crash/restart loop, which turns a clear failure into a hung command.
  //
  // stdio: "ignore" is essential on Windows. pg_ctl implements -l by launching
  // the server under `cmd.exe /C ... >> logfile`, and that long-lived child
  // inherits whatever handles we give it. With piped stdio, spawnSync waits for
  // the pipe to close — which only happens when the *server* exits — so the
  // command hangs forever. Startup problems are read back from LOG_FILE below.
  const res = run(
    bin("pg_ctl"),
    [
      "-D",
      DATA_DIR,
      "-l",
      LOG_FILE,
      "-o",
      `-p ${PORT} -c listen_addresses=127.0.0.1`,
      "-w",
      "-t",
      String(START_TIMEOUT_SECONDS),
      "start",
    ],
    { stdio: "ignore" },
  );
  if (res.status !== 0 || serverStatus() !== "running") {
    fail(
      `server failed to start within ${START_TIMEOUT_SECONDS}s.\n` +
        `--- last lines of ${LOG_FILE} ---\n${logTail()}\n\n` +
        `If this mentions exception 0xC0000142, Windows was out of resources for a ` +
        `new process — close some apps and retry. Otherwise the log names the cause.`,
    );
  }
  log(`started on port ${PORT} (log: ${LOG_FILE})`);
}

function stop() {
  if (!fs.existsSync(bin("pg_ctl")) || serverStatus() !== "running") {
    log("not running (nothing to stop)");
    clearStalePidFile();
    return;
  }
  const res = run(bin("pg_ctl"), [
    "-D",
    DATA_DIR,
    "-m",
    "fast",
    "-w",
    "-t",
    String(STOP_TIMEOUT_SECONDS),
    "stop",
  ]);
  if (res.status !== 0) {
    fail(`clean shutdown failed:\n${res.stderr || res.stdout}`);
  }
  log("stopped");
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function psql(args, { db = "postgres", allowFail = false } = {}) {
  const res = run(bin("psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    PORT,
    "-U",
    "postgres",
    "-d",
    db,
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    ...args,
  ]);
  if (res.status !== 0 && !allowFail) {
    fail(`psql failed:\n${res.stderr || res.stdout}`);
  }
  return res;
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR))
    fail(`no migrations directory at ${MIGRATIONS_DIR}`);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // timestamp-prefixed, so lexical order is chronological
  if (files.length === 0) fail(`no .sql migrations found in ${MIGRATIONS_DIR}`);
  return files;
}

async function reset() {
  await start({ quiet: true });
  log(`recreating database "${DB_NAME}"`);
  // WITH (FORCE) drops even when idle test connections are still attached.
  psql(["-c", `drop database if exists ${DB_NAME} with (force);`]);
  psql(["-c", `create database ${DB_NAME};`]);

  for (const file of migrationFiles()) {
    log(`applying ${file}`);
    psql(["-f", path.join(MIGRATIONS_DIR, file)], { db: DB_NAME });
  }
  log(`ready: ${DATABASE_URL}`);
}

function status() {
  const state = fs.existsSync(bin("pg_ctl")) ? serverStatus() : "absent";
  log(`binaries: ${fs.existsSync(bin("pg_ctl")) ? BIN_DIR : "not installed"}`);
  log(`version:  PostgreSQL ${PG_VERSION} (pinned)`);
  log(`data dir: ${DATA_DIR}`);
  log(`server:   ${state}${state === "running" ? ` on port ${PORT}` : ""}`);
  if (state !== "running") return;
  const res = psql(
    ["-tAc", `select count(*) from pg_database where datname = '${DB_NAME}';`],
    { allowFail: true },
  );
  const exists = res.stdout?.trim() === "1";
  log(
    `database: ${DB_NAME} ${exists ? "present" : "missing (run npm run db:reset)"}`,
  );
}

// ---------------------------------------------------------------------------
// test:db
// ---------------------------------------------------------------------------

async function test() {
  await start({ quiet: true });
  await reset();
  log("running the full integration suite with REQUIRE_DB=1");

  // Run vitest's entry point with the current Node binary rather than going
  // through `npm run` with shell:true — on Windows that path goes via cmd.exe
  // and npm's .cmd shim, which can hang forever when stdio is inherited from a
  // non-interactive parent.
  const vitest = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!fs.existsSync(vitest)) {
    fail(`vitest not found at ${vitest} — run npm install first`);
  }
  const child = spawn(process.execPath, [vitest, "run", "tests/integration"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL, REQUIRE_DB: "1" },
  });
  child.on("error", (error) =>
    fail(`could not start vitest: ${error.message}`),
  );
  child.on("exit", (code) => process.exit(code ?? 1));
}

// ---------------------------------------------------------------------------

const COMMANDS = { start, stop, reset, status, test };

const command = process.argv[2];
if (!command || !(command in COMMANDS)) {
  console.error(
    `usage: node scripts/db.mjs <${Object.keys(COMMANDS).join("|")}>`,
  );
  process.exit(1);
}
await COMMANDS[command]();
