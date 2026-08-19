import { Pool } from "pg";
import type { PoolClient } from "pg";
import { describe } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Integration-test harness for the queue engine.
 *
 * These tests exercise the real PostgreSQL functions and constraints against a
 * local Supabase database. They connect directly with the `pg` driver as the
 * `postgres` role (which owns the SECURITY DEFINER functions and bypasses RLS),
 * so they test the queue logic, not the Ticket 6 authorization layer.
 *
 * They only run when a database connection string is provided via
 * DATABASE_URL (or SUPABASE_DB_URL). When neither is set — e.g. Docker / the
 * local Supabase stack is unavailable — the suites are skipped rather than
 * silently "passing". Start the stack and point the tests at it with:
 *
 *   npx supabase start
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npm run test:integration
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "";

export const hasDatabase = DATABASE_URL.length > 0;

/**
 * Set REQUIRE_DB=1 to make the database suites mandatory: without a connection
 * string they fail loudly instead of skipping. CI for Ticket 1 should set this
 * so real-PostgreSQL verification can never silently pass by being skipped.
 */
export const requireDatabase = process.env.REQUIRE_DB === "1";

if (requireDatabase && !hasDatabase) {
  throw new Error(
    "REQUIRE_DB=1 but no DATABASE_URL/SUPABASE_DB_URL is set — real-PostgreSQL " +
      "tests cannot run. Start the stack (npx supabase start) and export the URL.",
  );
}

/** describe() that skips cleanly when no database is configured. */
export const describeDb: typeof describe.skip = hasDatabase
  ? describe
  : describe.skip;

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Resolves true when a database promise remains unsettled after `ms`. */
export async function isStillPending(
  promise: Promise<unknown>,
  ms = 700,
): Promise<boolean> {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
  ]);
  return result === marker;
}

export interface CreatedSession {
  sessionId: string;
  studentCode: string;
  staffCode: string;
}

export interface CreateSessionOptions {
  rentalDurationMinutes?: number;
  pickupWindowMinutes?: number;
  status?: "DRAFT" | "ACTIVE" | "CLOSED";
}

/** Insert a fresh ACTIVE session with unique codes. */
export async function createSession(
  client: Pool | PoolClient,
  options: CreateSessionOptions = {},
): Promise<CreatedSession> {
  const {
    rentalDurationMinutes = 60,
    pickupWindowMinutes = 10,
    status = "ACTIVE",
  } = options;
  const studentCode = `stu_${randomUUID().slice(0, 8)}`;
  const staffCode = `stf_${randomUUID().slice(0, 8)}`;
  const staffLinkHash = randomUUID().replaceAll("-", "").repeat(2);
  const res = await client.query(
    `insert into public.sessions
       (name, status, student_code, staff_code, staff_link_hash,
        rental_duration_minutes, pickup_window_minutes, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id`,
    [
      "Test Session",
      status,
      studentCode,
      staffCode,
      staffLinkHash,
      rentalDurationMinutes,
      pickupWindowMinutes,
    ],
  );
  return { sessionId: res.rows[0].id as string, studentCode, staffCode };
}

/** Add bins to a session and return their ids in insertion order. */
export async function addBins(
  client: Pool | PoolClient,
  sessionId: string,
  binNumbers: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const binNumber of binNumbers) {
    const res = await client.query(
      `insert into public.bins (session_id, bin_number) values ($1, $2) returning id`,
      [sessionId, binNumber],
    );
    ids.push(res.rows[0].id as string);
  }
  return ids;
}

export interface JoinResult {
  queueEntryId: string;
  status: string;
  position: number;
  estimatedWaitMinutes: number | null;
  pickupCode: string | null;
}

let joinCounter = 0;

/** Call join_queue with unique student data and return the parsed result. */
export async function joinQueue(
  client: Pool | PoolClient,
  sessionId: string,
  overrides: Partial<{
    fullName: string;
    pantherId: string;
    email: string;
    phone: string;
  }> = {},
): Promise<JoinResult> {
  joinCounter += 1;
  const unique = `${Date.now()}${joinCounter}`.slice(-10);
  const fullName = overrides.fullName ?? `Student ${joinCounter}`;
  const pantherId = overrides.pantherId ?? `900${unique}`;
  const email =
    overrides.email ?? `student${joinCounter}.${unique}@example.edu`;
  const phone = overrides.phone ?? `+1${unique.padStart(10, "9")}`;

  const res = await client.query(
    `select public.join_queue($1, $2, $3, $4, $5, true) as result`,
    [sessionId, fullName, pantherId, email, phone],
  );
  const result = res.rows[0].result;
  const entry = result.queue_entry;
  return {
    queueEntryId: entry.id as string,
    status: entry.status as string,
    position: result.position as number,
    estimatedWaitMinutes: result.estimated_wait_minutes as number | null,
    pickupCode: entry.pickup_code as string | null,
  };
}

/** Read a queue entry row. */
export async function getEntry(client: Pool | PoolClient, id: string) {
  const res = await client.query(
    `select * from public.queue_entries where id = $1`,
    [id],
  );
  return res.rows[0];
}

/** Read the ordered waiting entries for a session. */
export async function getWaitlist(
  client: Pool | PoolClient,
  sessionId: string,
) {
  const res = await client.query(
    `select id, queue_rank, phone
       from public.queue_entries
      where session_id = $1 and status = 'WAITING'
      order by queue_rank asc nulls last, joined_at asc, id asc`,
    [sessionId],
  );
  return res.rows as Array<{ id: string; queue_rank: number; phone: string }>;
}

/** Read the pickup code and reserved bin number for a READY entry. */
export async function getReadyDetails(
  client: Pool | PoolClient,
  entryId: string,
): Promise<{ pickupCode: string; binNumber: string } | null> {
  const res = await client.query(
    `select qe.pickup_code, b.bin_number
       from public.queue_entries qe
       join public.bins b on b.id = qe.reserved_bin_id
      where qe.id = $1 and qe.status = 'READY'`,
    [entryId],
  );
  if (res.rowCount === 0) {
    return null;
  }
  return {
    pickupCode: res.rows[0].pickup_code as string,
    binNumber: res.rows[0].bin_number as string,
  };
}

export async function checkout(
  client: Pool | PoolClient,
  args: {
    sessionId: string;
    pickupCode: string;
    binNumber: string;
    // `null` is representable so tests can prove a missing confirmation or
    // missing idempotency key is rejected rather than assumed.
    panthercardCollected?: boolean | null;
    staffLabel?: string;
    idempotencyKey: string | null;
  },
) {
  const res = await client.query(
    `select public.checkout($1, $2, $3, $4, $5, $6) as result`,
    [
      args.sessionId,
      args.pickupCode,
      args.binNumber,
      args.panthercardCollected === undefined
        ? true
        : args.panthercardCollected,
      args.staffLabel ?? "Staff A",
      args.idempotencyKey,
    ],
  );
  return res.rows[0].result;
}

export async function returnRental(
  client: Pool | PoolClient,
  args: {
    sessionId: string;
    binNumber: string;
    panthercardReturned?: boolean | null;
    staffLabel?: string;
    idempotencyKey: string | null;
  },
) {
  const res = await client.query(
    `select public.return_rental($1, $2, $3, $4, $5) as result`,
    [
      args.sessionId,
      args.binNumber,
      args.panthercardReturned === undefined ? true : args.panthercardReturned,
      args.staffLabel ?? "Staff B",
      args.idempotencyKey,
    ],
  );
  return res.rows[0].result;
}

export async function hold(
  client: Pool | PoolClient,
  sessionId: string,
  queueEntryId: string,
) {
  const res = await client.query(
    `select public.hold_reservation($1, $2) as result`,
    [sessionId, queueEntryId],
  );
  return res.rows[0].result;
}

export async function expireReservations(
  client: Pool | PoolClient,
  sessionId: string,
): Promise<number> {
  const res = await client.query(
    `select public.expire_reservations($1) as count`,
    [sessionId],
  );
  return res.rows[0].count as number;
}

/** Force the currently ACTIVE reservation(s) of a session to be expired. */
export async function forceExpireActiveReservations(
  client: Pool | PoolClient,
  sessionId: string,
): Promise<void> {
  await client.query(
    `update public.reservations
        set expires_at = now() - interval '1 minute'
      where session_id = $1 and status = 'ACTIVE'`,
    [sessionId],
  );
}

/** Force an OUT rental (by bin number) to be overdue. */
export async function forceOverdue(
  client: Pool | PoolClient,
  sessionId: string,
  binNumber: string,
  minutesOverdue = 5,
): Promise<void> {
  await client.query(
    `update public.rentals r
        set due_at = now() - make_interval(mins => $3)
       from public.bins b
      where b.id = r.bin_id
        and r.session_id = $1
        and b.bin_number = $2
        and r.status = 'OUT'`,
    [sessionId, binNumber, minutesOverdue],
  );
}
