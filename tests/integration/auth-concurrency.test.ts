import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { closePool, describeDb, getPool, isStillPending } from "./helpers/db";

afterAll(async () => {
  await closePool();
});

const RATE_BARRIER_A = 861_001;
const RATE_BARRIER_B = 861_002;
const STAFF_BARRIER = 861_003;

async function dropRateBarrier(): Promise<void> {
  await getPool().query(`
    drop trigger if exists test_rate_limit_cleanup_barrier
      on public.rate_limit_buckets;
    drop function if exists public.test_rate_limit_cleanup_barrier();
  `);
}

async function dropStaffBarrier(): Promise<void> {
  await getPool().query(`
    drop trigger if exists test_staff_session_cleanup_barrier
      on public.staff_web_sessions;
    drop function if exists public.test_staff_session_cleanup_barrier();
  `);
}

describeDb("Ticket 6 authorization concurrency on real PostgreSQL", () => {
  it("atomically allows exactly the configured number of simultaneous attempts", async () => {
    const pool = getPool();
    const scope = `atomic_${randomUUID().replaceAll("-", "")}`;
    const identity = "9".repeat(64);
    await pool.query(
      `insert into public.rate_limit_buckets (
         scope, identity_hash, request_count, window_started_at, expires_at
       ) values ($1, $2, 1, now() - interval '2 minutes', now() - interval '1 minute')`,
      [scope, identity],
    );

    const locker = await pool.connect();
    await locker.query("begin");
    await locker.query(
      `select 1 from public.rate_limit_buckets
       where scope = $1 and identity_hash = $2
       for update`,
      [scope, identity],
    );
    const pendingAttempts = Array.from({ length: 20 }, () =>
      pool.query(`select public.consume_rate_limit($1, $2, 7, 60) as result`, [
        scope,
        identity,
      ]),
    );
    let genuinelyContended = false;
    try {
      genuinelyContended = await isStillPending(pendingAttempts[0]);
    } finally {
      await locker.query("rollback");
      locker.release();
    }

    expect(genuinelyContended).toBe(true);
    const attempts = await Promise.all(pendingAttempts);
    const allowed = attempts.filter(
      (attempt) => attempt.rows[0].result.allowed === true,
    );
    expect(allowed).toHaveLength(7);
    const bucket = await pool.query(
      `select request_count from public.rate_limit_buckets
       where scope = $1 and identity_hash = $2`,
      [scope, identity],
    );
    expect(bucket.rows[0].request_count).toBe(8);
  });

  it("does not deadlock when two identities clean up each other's expired buckets", async () => {
    const pool = getPool();
    const scope = `cleanup_${randomUUID().replaceAll("-", "")}`;
    const identityA = "a".repeat(64);
    const identityB = "b".repeat(64);
    await pool.query(
      `insert into public.rate_limit_buckets (
         scope, identity_hash, request_count, window_started_at, expires_at
       ) values
         ($1, $2, 1, now() - interval '4 minutes', now() - interval '3 minutes'),
         ($1, $3, 1, now() - interval '5 minutes', now() - interval '4 minutes')`,
      [scope, identityA, identityB],
    );

    await dropRateBarrier();
    await pool.query(`
      create function public.test_rate_limit_cleanup_barrier()
      returns trigger
      language plpgsql
      set search_path = ''
      as $trigger$
      begin
        if old.scope = '${scope}' then
          if old.identity_hash = '${identityA}' then
            perform pg_catalog.pg_advisory_xact_lock(${RATE_BARRIER_A});
          elsif old.identity_hash = '${identityB}' then
            perform pg_catalog.pg_advisory_xact_lock(${RATE_BARRIER_B});
          end if;
        end if;
        return old;
      end;
      $trigger$;
      create trigger test_rate_limit_cleanup_barrier
        before delete on public.rate_limit_buckets
        for each row
        execute function public.test_rate_limit_cleanup_barrier();
    `);

    const controller = await pool.connect();
    await controller.query(
      `select pg_catalog.pg_advisory_lock($1),
              pg_catalog.pg_advisory_lock($2)`,
      [RATE_BARRIER_A, RATE_BARRIER_B],
    );

    const attempts = [identityA, identityB].map((identity) =>
      pool.query(`select public.consume_rate_limit($1, $2, 7, 60) as result`, [
        scope,
        identity,
      ]),
    );
    try {
      // Give both calls time to reach the test-only DELETE barriers. With the
      // old cleanup-first ordering each holds the other's row at this point;
      // releasing the barriers deterministically produces SQLSTATE 40P01.
      await Promise.all(attempts.map((attempt) => isStillPending(attempt)));
      await controller.query("select pg_catalog.pg_advisory_unlock_all()");
      const results = await Promise.allSettled(attempts);
      expect(results.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
    } finally {
      await controller.query("select pg_catalog.pg_advisory_unlock_all()");
      controller.release();
      await Promise.allSettled(attempts);
      await dropRateBarrier();
    }
  });

  it("keeps staff exchange and session ending on one lock order", async () => {
    const pool = getPool();
    const sessionId = randomUUID();
    const linkHash = "c".repeat(64);
    const expiredTokenHash = "d".repeat(64);
    const newTokenHash = "e".repeat(64);
    await pool.query(
      `insert into public.sessions (
         id, name, status, student_code, staff_code, staff_link_hash,
         staff_credential_version, rental_duration_minutes,
         pickup_window_minutes, started_at
       ) values ($1, 'Staff cleanup probe', 'ACTIVE', $2, $3, $4,
         'hmac-v1', 60, 10, now())`,
      [
        sessionId,
        `signup-${randomUUID().replaceAll("-", "").slice(0, 32)}`,
        "v1.protected-link",
        linkHash,
      ],
    );
    await pool.query(
      `insert into public.staff_web_sessions (
         session_id, token_hash, created_at, expires_at
       ) values ($1, $2, now() - interval '2 hours', now() - interval '1 hour')`,
      [sessionId, expiredTokenHash],
    );

    await dropStaffBarrier();
    await pool.query(`
      create function public.test_staff_session_cleanup_barrier()
      returns trigger
      language plpgsql
      set search_path = ''
      as $trigger$
      begin
        if old.token_hash = '${expiredTokenHash}' then
          perform pg_catalog.pg_advisory_xact_lock(${STAFF_BARRIER});
        end if;
        return old;
      end;
      $trigger$;
      create trigger test_staff_session_cleanup_barrier
        before delete on public.staff_web_sessions
        for each row
        execute function public.test_staff_session_cleanup_barrier();
    `);

    const controller = await pool.connect();
    await controller.query("select pg_catalog.pg_advisory_lock($1)", [
      STAFF_BARRIER,
    ]);
    const exchange = pool.query(
      `select public.create_staff_web_session(
         $1, $2, now() + interval '1 hour'
       ) as result`,
      [[linkHash], newTokenHash],
    );
    const exchangeReachedCleanup = await isStillPending(exchange);
    const endSession = pool.query(
      `select public.admin_end_session($1) as result`,
      [sessionId],
    );
    const endSessionContended = await isStillPending(endSession);

    const attempts = [exchange, endSession];
    try {
      await controller.query("select pg_catalog.pg_advisory_unlock_all()");
      const results = await Promise.allSettled(attempts);
      expect(exchangeReachedCleanup).toBe(true);
      expect(endSessionContended).toBe(true);
      expect(results.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
    } finally {
      await controller.query("select pg_catalog.pg_advisory_unlock_all()");
      controller.release();
      await Promise.allSettled(attempts);
      await dropStaffBarrier();
    }
  });
});
