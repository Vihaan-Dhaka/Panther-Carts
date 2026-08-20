import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { closePool, describeDb, getPool, isStillPending } from "./helpers/db";

afterAll(async () => {
  await closePool();
});

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

  it("never waits on another identity during expired-bucket cleanup", async () => {
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

    const locker = await pool.connect();
    await locker.query("begin");
    await locker.query(
      `select 1 from public.rate_limit_buckets
       where scope = $1 and identity_hash = $2
       for update`,
      [scope, identityB],
    );

    const attempt = pool.query(
      `select public.consume_rate_limit($1, $2, 7, 60) as result`,
      [scope, identityA],
    );
    let blockedByOtherIdentity = true;
    try {
      blockedByOtherIdentity = await isStillPending(attempt);
    } finally {
      await locker.query("rollback");
      locker.release();
    }
    const result = await attempt;

    expect(blockedByOtherIdentity).toBe(false);
    expect(result.rows[0].result.allowed).toBe(true);
  });
});
