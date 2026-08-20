import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * PGlite harness — runs the real Supabase migrations inside an in-process WASM
 * build of PostgreSQL. This exercises the actual schema, constraints, and
 * queue-engine functions without Docker, so the single-connection logic is
 * genuinely verified in CI and locally.
 *
 * PGlite is single-connection, so it cannot reproduce true multi-connection
 * races — those live in the pg-driver suite (queue-engine / concurrency),
 * which run against a real Postgres/Supabase and skip when none is configured.
 */
const MIGRATIONS_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../supabase/migrations",
);

export type Db = PGlite;

export async function applyMigration(db: Db, fileName: string): Promise<void> {
  if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(fileName)) {
    throw new Error("Invalid migration filename");
  }
  await db.exec(readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8"));
}

export async function createMigratedDb(
  options: { createServiceRole?: boolean; throughMigration?: string } = {},
): Promise<Db> {
  const db = new PGlite();
  if (options.createServiceRole) {
    await db.exec(`
      create role service_role nologin bypassrls;
      create role anon nologin;
      create role authenticated nologin;
      alter default privileges in schema public
        grant execute on functions to anon, authenticated;
    `);
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await applyMigration(db, file);
    if (file === options.throughMigration) break;
  }
  return db;
}

export interface CreateSessionOptions {
  rentalDurationMinutes?: number;
  pickupWindowMinutes?: number;
  status?: "DRAFT" | "ACTIVE" | "CLOSED";
}

export async function createSession(
  db: Db,
  options: CreateSessionOptions = {},
): Promise<string> {
  const {
    rentalDurationMinutes = 60,
    pickupWindowMinutes = 10,
    status = "ACTIVE",
  } = options;
  const protectedSchema = await db.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'sessions'
         and column_name = 'staff_link_hash'
     ) as present`,
  );
  const res = protectedSchema.rows[0].present
    ? await db.query<{ id: string }>(
        `insert into public.sessions
       (name, status, student_code, staff_code, staff_link_hash,
        rental_duration_minutes, pickup_window_minutes, started_at)
     values ('Test', $1, $2, $3, $4, $5, $6, now())
     returning id`,
        [
          status,
          `stu_${randomUUID().slice(0, 8)}`,
          `stf_${randomUUID().slice(0, 8)}`,
          randomUUID().replaceAll("-", "").repeat(2),
          rentalDurationMinutes,
          pickupWindowMinutes,
        ],
      )
    : await db.query<{ id: string }>(
        `insert into public.sessions
           (name, status, student_code, staff_code,
            rental_duration_minutes, pickup_window_minutes, started_at)
         values ('Test', $1, $2, $3, $4, $5, now())
         returning id`,
        [
          status,
          `stu_${randomUUID().slice(0, 8)}`,
          `stf_${randomUUID().slice(0, 8)}`,
          rentalDurationMinutes,
          pickupWindowMinutes,
        ],
      );
  return res.rows[0].id;
}

export async function addBins(
  db: Db,
  sessionId: string,
  binNumbers: string[],
): Promise<void> {
  for (const binNumber of binNumbers) {
    await db.query(
      `insert into public.bins (session_id, bin_number) values ($1, $2)`,
      [sessionId, binNumber],
    );
  }
}

interface JoinRpcResult {
  queue_entry: {
    id: string;
    status: string;
    pickup_code: string | null;
  };
  position: number;
  estimated_wait_minutes: number | null;
}

export interface JoinResult {
  queueEntryId: string;
  status: string;
  position: number;
  estimatedWaitMinutes: number | null;
}

let counter = 0;

export async function joinQueue(
  db: Db,
  sessionId: string,
  overrides: { phone?: string } = {},
): Promise<JoinResult> {
  counter += 1;
  const unique = String(counter).padStart(10, "5");
  const phone = overrides.phone ?? `+1${unique}`;
  const res = await db.query<{ r: JoinRpcResult }>(
    `select public.join_queue($1, $2, $3, $4, $5, true) as r`,
    [
      sessionId,
      `Student ${counter}`,
      `900${unique}`,
      `s${counter}@example.edu`,
      phone,
    ],
  );
  const r = res.rows[0].r;
  return {
    queueEntryId: r.queue_entry.id,
    status: r.queue_entry.status,
    position: r.position,
    estimatedWaitMinutes: r.estimated_wait_minutes,
  };
}

export async function getEntry(db: Db, id: string) {
  const res = await db.query<{
    id: string;
    status: string;
    hold_used: boolean;
    queue_rank: number | null;
  }>(
    `select id, status, hold_used, queue_rank from public.queue_entries where id = $1`,
    [id],
  );
  return res.rows[0];
}

export async function getWaitlist(db: Db, sessionId: string) {
  const res = await db.query<{ id: string; queue_rank: number }>(
    `select id, queue_rank from public.queue_entries
      where session_id = $1 and status = 'WAITING'
      order by queue_rank asc nulls last, joined_at asc, id asc`,
    [sessionId],
  );
  return res.rows;
}

export async function getReadyDetails(db: Db, entryId: string) {
  const res = await db.query<{ pickup_code: string; bin_number: string }>(
    `select qe.pickup_code, b.bin_number
       from public.queue_entries qe
       join public.bins b on b.id = qe.reserved_bin_id
      where qe.id = $1 and qe.status = 'READY'`,
    [entryId],
  );
  return res.rows[0] ?? null;
}

export async function checkout(
  db: Db,
  args: {
    sessionId: string;
    pickupCode: string;
    binNumber: string;
    // `null` is deliberately representable so tests can prove a missing
    // confirmation / missing idempotency key is rejected rather than assumed.
    panthercardCollected?: boolean | null;
    idempotencyKey: string | null;
  },
) {
  const res = await db.query<{ r: Record<string, unknown> }>(
    `select public.checkout($1, $2, $3, $4, $5, $6) as r`,
    [
      args.sessionId,
      args.pickupCode,
      args.binNumber,
      args.panthercardCollected === undefined
        ? true
        : args.panthercardCollected,
      "Staff A",
      args.idempotencyKey,
    ],
  );
  return res.rows[0].r;
}

export async function returnRental(
  db: Db,
  args: {
    sessionId: string;
    binNumber: string;
    panthercardReturned?: boolean | null;
    idempotencyKey: string | null;
  },
) {
  const res = await db.query<{ r: Record<string, unknown> }>(
    `select public.return_rental($1, $2, $3, $4, $5) as r`,
    [
      args.sessionId,
      args.binNumber,
      args.panthercardReturned === undefined ? true : args.panthercardReturned,
      "Staff B",
      args.idempotencyKey,
    ],
  );
  return res.rows[0].r;
}

export async function hold(db: Db, sessionId: string, queueEntryId: string) {
  const res = await db.query<{
    r: { position: number; promoted_entry_id: string };
  }>(`select public.hold_reservation($1, $2) as r`, [sessionId, queueEntryId]);
  return res.rows[0].r;
}

export async function expireReservations(
  db: Db,
  sessionId: string,
): Promise<number> {
  const res = await db.query<{ c: number }>(
    `select public.expire_reservations($1) as c`,
    [sessionId],
  );
  return Number(res.rows[0].c);
}

export async function forceExpireActive(
  db: Db,
  sessionId: string,
): Promise<void> {
  await db.query(
    `update public.reservations set expires_at = now() - interval '1 minute'
      where session_id = $1 and status = 'ACTIVE'`,
    [sessionId],
  );
}

export async function forceOverdue(
  db: Db,
  sessionId: string,
  binNumber: string,
  minutes = 5,
): Promise<void> {
  await db.query(
    `update public.rentals r set due_at = now() - make_interval(mins => $3)
       from public.bins b
      where b.id = r.bin_id and r.session_id = $1 and b.bin_number = $2 and r.status = 'OUT'`,
    [sessionId, binNumber, minutes],
  );
}

export async function count(
  db: Db,
  sql: string,
  params: unknown[],
): Promise<number> {
  const res = await db.query<{ c: number }>(sql, params);
  return Number(res.rows[0].c);
}
