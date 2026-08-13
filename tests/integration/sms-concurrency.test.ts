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
  it("serializes duplicate inbound deliveries into one mutation and response", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    const phone = "+14045550801";
    await joinQueue(pool, sessionId, { phone });
    const eventId = randomUUID();
    const messageId = randomUUID();
    const gate = await pool.connect();
    try {
      await gate.query("begin");
      await gate.query(
        "select public.lock_idempotency_key('inbound_sms_event',$1)",
        [`telnyx:${eventId}`],
      );
      const deliver = () =>
        pool.query(
          `select public.handle_inbound_sms(
             'telnyx',$1,$2,$3,'+14045550100',now(),'TIME',null
           ) as result`,
          [eventId, messageId, phone],
        );
      const first = deliver();
      const second = deliver();
      expect(await isStillPending(first)).toBe(true);
      expect(await isStillPending(second)).toBe(true);

      await gate.query("commit");
      const results = (await Promise.all([first, second])).map(
        (query) => query.rows[0].result as Record<string, unknown>,
      );
      expect(
        results.filter((result) => result.duplicate === false),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.duplicate === true),
      ).toHaveLength(1);
      const counts = await pool.query(
        `select
           (select count(*)::int from public.inbound_sms_events
             where provider='telnyx' and provider_event_id=$1) as events,
           (select count(*)::int from public.notification_outbox
             where session_id=$2 and type='TIME') as responses`,
        [eventId, sessionId],
      );
      expect(counts.rows[0]).toEqual({ events: 1, responses: 1 });
    } finally {
      try {
        await gate.query("rollback");
      } catch {
        // Transaction may already be committed.
      }
      gate.release();
    }
  });

  it("serializes inbound resolution behind signup for the same phone", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    const phone = "+14045550802";
    const gate = await pool.connect();
    try {
      await gate.query("begin");
      await gate.query(
        "select public.lock_idempotency_key('active_phone',$1)",
        [phone],
      );
      const signup = joinQueue(pool, sessionId, { phone });
      expect(await isStillPending(signup)).toBe(true);
      const inbound = pool.query(
        `select public.handle_inbound_sms(
           'telnyx',$1,$2,$3,'+14045550100',now(),'TIME',null
         ) as result`,
        [randomUUID(), randomUUID(), phone],
      );
      expect(await isStillPending(inbound)).toBe(true);

      await gate.query("commit");
      const joined = await signup;
      const response = await inbound;
      expect(response.rows[0].result).toMatchObject({
        duplicate: false,
        outcome: "TIME_WAITING",
      });
      expect((await getEntry(pool, joined.queueEntryId)).status).toBe(
        "WAITING",
      );
    } finally {
      try {
        await gate.query("rollback");
      } catch {
        // Transaction may already be committed.
      }
      gate.release();
    }
  });

  it("rechecks HOLD after reservation expiry wins the session lock", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const phone = "+14045550803";
    const holder = await joinQueue(pool, sessionId, { phone });
    const next = await joinQueue(pool, sessionId);
    const locker = await holdSessionLock(sessionId);
    try {
      await locker.query(
        `update public.reservations
         set expires_at=now()-interval '1 second'
         where session_id=$1 and queue_entry_id=$2 and status='ACTIVE'`,
        [sessionId, holder.queueEntryId],
      );
      const hold = pool.query(
        `select public.handle_inbound_sms(
           'telnyx',$1,$2,$3,'+14045550100',now(),'HOLD',null
         ) as result`,
        [randomUUID(), randomUUID(), phone],
      );
      expect(await isStillPending(hold)).toBe(true);

      await locker.query("select public.expire_reservations($1)", [sessionId]);
      await locker.query("commit");
      const response = await hold;
      expect(response.rows[0].result).toMatchObject({
        duplicate: false,
        outcome: "NO_ACTIVE_MATCH",
      });
      expect((await getEntry(pool, holder.queueEntryId)).status).toBe(
        "EXPIRED",
      );
      expect((await getEntry(pool, next.queueEntryId)).status).toBe("READY");
    } finally {
      try {
        await locker.query("rollback");
      } catch {
        // Transaction may already be committed.
      }
      locker.release();
    }
  });

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

    const workerA = await pool.connect();
    const workerB = await pool.connect();
    try {
      await workerA.query("begin");
      const claimA = await workerA.query(
        `select * from public.claim_notification_outbox('worker-a',3,120,5)`,
      );
      expect(claimA.rows.map((row) => row.id)).toContain(outboxId);

      // Keep A's row lock and transaction open while B executes the same
      // claim query. B must skip the locked row rather than wait or claim it.
      await workerB.query("begin");
      const claimB = await workerB.query(
        `select * from public.claim_notification_outbox('worker-b',3,120,5)`,
      );
      expect(claimB.rows.map((row) => row.id)).not.toContain(outboxId);

      await workerB.query("commit");
      await workerA.query("commit");
      const final = await pool.query(
        `select attempts, status::text from public.notification_outbox where id=$1`,
        [outboxId],
      );
      expect(final.rows[0]).toEqual({ attempts: 1, status: "PROCESSING" });
    } finally {
      for (const client of [workerA, workerB]) {
        try {
          await client.query("rollback");
        } catch {
          // Ignore cleanup after a committed transaction.
        }
        client.release();
      }
    }
  });

  it("skips a locked max-attempt row while claiming other eligible work", async () => {
    const pool = getPool();
    const exhausted = await pool.query(
      `insert into public.notification_outbox
        (type,body,dedupe_key,destination_phone,status,attempts,available_at)
       values (
         'TIME','Panther Carts: Exhausted. STOP=opt out.',$1,
         '+14045550123','PENDING',5,
         timestamp with time zone '1999-01-01 00:00:00+00'
       ) returning id`,
      [randomUUID()],
    );
    const eligible = await pool.query(
      `insert into public.notification_outbox
        (type,body,dedupe_key,destination_phone,available_at)
       values (
         'TIME','Panther Carts: Eligible. STOP=opt out.',$1,
         '+14045550124',timestamp with time zone '2000-01-01 00:00:00+00'
       ) returning id`,
      [randomUUID()],
    );
    const exhaustedId = exhausted.rows[0].id as string;
    const eligibleId = eligible.rows[0].id as string;
    const locker = await pool.connect();
    try {
      await locker.query("begin");
      await locker.query(
        `select id from public.notification_outbox where id=$1 for update`,
        [exhaustedId],
      );

      const claim = await pool.query(
        `select * from public.claim_notification_outbox('worker-b',3,120,5)`,
      );
      expect(claim.rows.map((row) => row.id)).toContain(eligibleId);
      const stillPending = await locker.query(
        `select status::text from public.notification_outbox where id=$1`,
        [exhaustedId],
      );
      expect(stillPending.rows[0].status).toBe("PENDING");
    } finally {
      try {
        await locker.query("rollback");
      } catch {
        // Ignore cleanup after a failed transaction.
      }
      locker.release();
    }
  });
});
