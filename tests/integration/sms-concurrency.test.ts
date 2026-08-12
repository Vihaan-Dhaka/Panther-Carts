import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  addBins,
  checkout,
  closePool,
  createSession,
  describeDb,
  getEntry,
  getPool,
  getReadyDetails,
  isStillPending,
  joinQueue,
} from "./helpers/db";

afterAll(async () => {
  await closePool();
});

async function holdSessionLock(sessionId: string): Promise<PoolClient> {
  const client = await getPool().connect();
  await client.query("begin");
  await client.query("select public.lock_session($1)", [sessionId]);
  return client;
}

describeDb("Ticket 5 forced SMS concurrency", () => {
  it("serializes READY cancellation against checkout and never releases an OUT bin", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const entry = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, entry.queueEntryId);
    const locker = await holdSessionLock(sessionId);
    try {
      const cancellation = pool.query(
        `select public.cancel_queue_entry($1,$2,$3) as result`,
        [sessionId, entry.queueEntryId, randomUUID()],
      );
      expect(await isStillPending(cancellation)).toBe(true);

      await checkout(locker, {
        sessionId,
        pickupCode: ready!.pickupCode,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      });
      await locker.query("commit");
      const result = await cancellation;
      expect(result.rows[0].result.outcome).toBe("CHECKED_OUT_REJECTED");
      expect((await getEntry(pool, entry.queueEntryId)).status).toBe(
        "CHECKED_OUT",
      );
      const state = await pool.query(
        `select b.status::text as bin_status, r.status::text as rental_status
         from public.bins b
         join public.rentals r on r.bin_id=b.id and r.session_id=b.session_id
         where b.session_id=$1 and b.bin_number='1'`,
        [sessionId],
      );
      expect(state.rows[0]).toEqual({
        bin_status: "OUT",
        rental_status: "OUT",
      });
    } finally {
      try {
        await locker.query("rollback");
      } catch {
        // Transaction may already be committed.
      }
      locker.release();
    }
  });

  it("simultaneous healthy workers cannot claim the same outbox row", async () => {
    const pool = getPool();
    const inserted = await pool.query(
      `insert into public.notification_outbox
        (type,body,dedupe_key,destination_phone,available_at)
       values (
         'TIME','Panther Carts: Test. STOP=opt out.',$1,'+14045550123',
         timestamp with time zone '2000-01-01 00:00:00+00'
       )
       returning id`,
      [randomUUID()],
    );
    const outboxId = inserted.rows[0].id as string;

    const gate = await pool.connect();
    const workerA = await pool.connect();
    const workerB = await pool.connect();
    const gateA = 7_405_001;
    const gateB = 7_405_002;
    try {
      await gate.query("select pg_advisory_lock($1), pg_advisory_lock($2)", [
        gateA,
        gateB,
      ]);

      const runWorker = async (
        client: PoolClient,
        gateKey: number,
        label: string,
      ) => {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1)", [gateKey]);
        const claimed = await client.query(
          `select * from public.claim_notification_outbox($1,10,120,5)`,
          [label],
        );
        await client.query("commit");
        return claimed.rows as Array<{ id: string }>;
      };

      const claimA = runWorker(workerA, gateA, "worker-a");
      const claimB = runWorker(workerB, gateB, "worker-b");
      expect(await isStillPending(claimA)).toBe(true);
      expect(await isStillPending(claimB)).toBe(true);

      await gate.query(
        "select pg_advisory_unlock($1), pg_advisory_unlock($2)",
        [gateA, gateB],
      );
      const [rowsA, rowsB] = await Promise.all([claimA, claimB]);
      const idsA = new Set(rowsA.map((row) => row.id));
      const idsB = new Set(rowsB.map((row) => row.id));
      expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
      expect(
        [...rowsA, ...rowsB].filter((row) => row.id === outboxId),
      ).toHaveLength(1);
    } finally {
      for (const client of [workerA, workerB]) {
        try {
          await client.query("rollback");
        } catch {
          // Ignore cleanup after a committed transaction.
        }
        client.release();
      }
      try {
        await gate.query(
          "select pg_advisory_unlock($1), pg_advisory_unlock($2)",
          [gateA, gateB],
        );
      } catch {
        // Locks may already be released.
      }
      gate.release();
    }
  });
});
