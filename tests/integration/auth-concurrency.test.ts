import { afterAll, expect, it } from "vitest";
import { closePool, describeDb, getPool } from "./helpers/db";

afterAll(async () => {
  await closePool();
});

describeDb("Ticket 6 authorization concurrency on real PostgreSQL", () => {
  it("atomically allows exactly the configured number of simultaneous attempts", async () => {
    const pool = getPool();
    const identity = "9".repeat(64);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        pool.query(
          `select public.consume_rate_limit(
             'concurrency_probe', $1, 7, 60
           ) as result`,
          [identity],
        ),
      ),
    );
    const allowed = attempts.filter(
      (attempt) => attempt.rows[0].result.allowed === true,
    );
    expect(allowed).toHaveLength(7);
    const bucket = await pool.query(
      `select request_count from public.rate_limit_buckets
       where scope = 'concurrency_probe' and identity_hash = $1`,
      [identity],
    );
    expect(bucket.rows[0].request_count).toBe(8);
  });
});
