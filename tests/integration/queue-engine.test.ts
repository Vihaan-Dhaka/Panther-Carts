import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addBins,
  checkout,
  closePool,
  createSession,
  describeDb,
  expireReservations,
  forceExpireActiveReservations,
  forceOverdue,
  getEntry,
  getPool,
  getReadyDetails,
  getWaitlist,
  hold,
  joinQueue,
  returnRental,
} from "./helpers/db";

afterAll(async () => {
  await closePool();
});

describeDb("schema constraints", () => {
  it("enforces unique bin numbers per session", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    await expect(addBins(pool, sessionId, ["1"])).rejects.toThrow(
      /duplicate key|bins_number_unique_per_session/i,
    );
  });

  it("has no bin-condition or QR columns anywhere", async () => {
    const pool = getPool();
    const res = await pool.query(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and (lower(column_name) like '%condition%'
               or lower(column_name) like '%qr%')`,
    );
    expect(res.rows).toEqual([]);
  });

  it("rejects a RETURNED rental without PantherCard return via the return op", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);
    expect(ready).not.toBeNull();
    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await expect(
      returnRental(pool, {
        sessionId,
        binNumber: "1",
        panthercardReturned: false,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/PANTHERCARD_REQUIRED/);
  });
});

describeDb("join + allocation", () => {
  it("allocates an available bin immediately on join", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    expect(a.status).toBe("READY");
    expect(a.position).toBe(0);
    const ready = await getReadyDetails(pool, a.queueEntryId);
    expect(ready?.pickupCode).toMatch(/^[0-9]{4}$/);
  });

  it("rejects a duplicate active entry for the same phone", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const phone = "+15551230000";
    await joinQueue(pool, sessionId, { phone });
    await expect(joinQueue(pool, sessionId, { phone })).rejects.toThrow(
      /DUPLICATE_ACTIVE_ENTRY/,
    );
  });

  it("preserves FIFO allocation order", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // takes the only bin
    const b = await joinQueue(pool, sessionId); // waits at rank 1
    const c = await joinQueue(pool, sessionId); // waits at rank 2
    expect(a.status).toBe("READY");
    expect(b.status).toBe("WAITING");
    expect(c.status).toBe("WAITING");

    // Free the bin; the earliest waiting entry (b) must be allocated next.
    const ready = await getReadyDetails(pool, a.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await returnRental(pool, {
      sessionId,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });

    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    expect((await getEntry(pool, c.queueEntryId)).status).toBe("WAITING");
  });

  it("keeps waiting ranks contiguous after allocations", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    await joinQueue(pool, sessionId); // READY
    await joinQueue(pool, sessionId); // rank 1
    await joinQueue(pool, sessionId); // rank 2
    await joinQueue(pool, sessionId); // rank 3
    const waitlist = await getWaitlist(pool, sessionId);
    expect(waitlist.map((w) => w.queue_rank)).toEqual([1, 2, 3]);
  });

  it("deduplicates outbox rows by dedupe_key", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    // Immediate allocation is combined into the one INITIAL signup message.
    const initial = await pool.query(
      `select count(*)::int as c from public.notification_outbox
        where session_id = $1 and type = 'INITIAL'`,
      [sessionId],
    );
    expect(initial.rows[0].c).toBe(1);
    // Re-running allocation must not create a separate READY notification.
    await pool.query(`select public.allocate_bins($1)`, [sessionId]);
    const ready = await pool.query(
      `select count(*)::int as c from public.notification_outbox
        where session_id = $1 and type = 'READY'`,
      [sessionId],
    );
    expect(ready.rows[0].c).toBe(0);
    expect(a.status).toBe("READY");
  });
});

describeDb("HOLD", () => {
  it("produces waitlist C, A, D from A reserved with B, C, D waiting", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY
    const b = await joinQueue(pool, sessionId); // wait
    const c = await joinQueue(pool, sessionId); // wait
    const d = await joinQueue(pool, sessionId); // wait

    const result = await hold(pool, sessionId, a.queueEntryId);
    expect(result.position).toBe(2);
    expect(result.promoted_entry_id).toBe(b.queueEntryId);

    // B promoted to READY; A back to WAITING with hold consumed.
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    const aEntry = await getEntry(pool, a.queueEntryId);
    expect(aEntry.status).toBe("WAITING");
    expect(aEntry.hold_used).toBe(true);

    const waitlist = await getWaitlist(pool, sessionId);
    expect(waitlist.map((w) => w.id)).toEqual([
      c.queueEntryId,
      a.queueEntryId,
      d.queueEntryId,
    ]);
    expect(waitlist.map((w) => w.queue_rank)).toEqual([1, 2, 3]);
  });

  it("makes A position one when only B is waiting", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY
    const b = await joinQueue(pool, sessionId); // wait

    const result = await hold(pool, sessionId, a.queueEntryId);
    expect(result.position).toBe(1);
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    const waitlist = await getWaitlist(pool, sessionId);
    expect(waitlist.map((w) => w.id)).toEqual([a.queueEntryId]);
  });

  it("rejects HOLD when nobody is waiting", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY, no one waiting
    await expect(hold(pool, sessionId, a.queueEntryId)).rejects.toThrow(
      /NOBODY_WAITING/,
    );
  });

  it("rejects a second HOLD from the same student", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY
    await joinQueue(pool, sessionId); // B waits
    await joinQueue(pool, sessionId); // E waits

    // First HOLD: B promoted, waitlist becomes [E, A].
    await hold(pool, sessionId, a.queueEntryId);

    // Recycle the bin twice so A eventually becomes READY again.
    await forceExpireActiveReservations(pool, sessionId);
    await expireReservations(pool, sessionId); // E promoted, waitlist [A]
    await forceExpireActiveReservations(pool, sessionId);
    await expireReservations(pool, sessionId); // A promoted -> READY again

    expect((await getEntry(pool, a.queueEntryId)).status).toBe("READY");
    await joinQueue(pool, sessionId); // G waits, so NOBODY_WAITING can't be the reason

    await expect(hold(pool, sessionId, a.queueEntryId)).rejects.toThrow(
      /HOLD_ALREADY_USED/,
    );
  });
});

describeDb("checkout / return / expiration idempotency", () => {
  it("is idempotent for return with the same key", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    const key = randomUUID();
    const first = await returnRental(pool, {
      sessionId,
      binNumber: "1",
      idempotencyKey: key,
    });
    const second = await returnRental(pool, {
      sessionId,
      binNumber: "1",
      idempotencyKey: key,
    });
    expect(second.idempotent_replay).toBe(true);
    expect(second.rental.id).toBe(first.rental.id);
    const rentals = await pool.query(
      `select count(*)::int as c from public.rentals where session_id = $1`,
      [sessionId],
    );
    expect(rentals.rows[0].c).toBe(1);
  });

  it("is idempotent and safe to run expiration repeatedly", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    await forceExpireActiveReservations(pool, sessionId);
    const firstCount = await expireReservations(pool, sessionId);
    expect(firstCount).toBe(1);
    const secondCount = await expireReservations(pool, sessionId);
    expect(secondCount).toBe(0);
    expect((await getEntry(pool, a.queueEntryId)).status).toBe("EXPIRED");
  });

  it("records was_late only when the return is actually late", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1", "2"]);
    const onTime = await joinQueue(pool, sessionId);
    const late = await joinQueue(pool, sessionId);
    const r1 = await getReadyDetails(pool, onTime.queueEntryId);
    const r2 = await getReadyDetails(pool, late.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: r1!.pickupCode,
      binNumber: r1!.binNumber,
      idempotencyKey: randomUUID(),
    });
    await checkout(pool, {
      sessionId,
      pickupCode: r2!.pickupCode,
      binNumber: r2!.binNumber,
      idempotencyKey: randomUUID(),
    });
    await forceOverdue(pool, sessionId, r2!.binNumber, 5);

    const onTimeResult = await returnRental(pool, {
      sessionId,
      binNumber: r1!.binNumber,
      idempotencyKey: randomUUID(),
    });
    const lateResult = await returnRental(pool, {
      sessionId,
      binNumber: r2!.binNumber,
      idempotencyKey: randomUUID(),
    });
    expect(onTimeResult.rental.was_late).toBe(false);
    expect(lateResult.rental.was_late).toBe(true);
  });
});

describeDb("estimated wait", () => {
  it("matches the sorted-return algorithm across cycles", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool, {
      rentalDurationMinutes: 60,
    });
    await addBins(pool, sessionId, ["1", "2"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);
    const ra = await getReadyDetails(pool, a.queueEntryId);
    const rb = await getReadyDetails(pool, b.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ra!.pickupCode,
      binNumber: ra!.binNumber,
      idempotencyKey: randomUUID(),
    });
    await checkout(pool, {
      sessionId,
      pickupCode: rb!.pickupCode,
      binNumber: rb!.binNumber,
      idempotencyKey: randomUUID(),
    });
    // Distinct, controlled due times: +10 and +40 minutes.
    await pool.query(
      `update public.rentals set due_at = now() + interval '10 minutes'
        where session_id = $1 and bin_id = (select id from public.bins where session_id=$1 and bin_number=$2)`,
      [sessionId, ra!.binNumber],
    );
    await pool.query(
      `update public.rentals set due_at = now() + interval '40 minutes'
        where session_id = $1 and bin_id = (select id from public.bins where session_id=$1 and bin_number=$2)`,
      [sessionId, rb!.binNumber],
    );

    // Compute the function output and the expected values in ONE query so
    // now() is identical for both (transaction_timestamp is constant).
    const res = await pool.query(
      `with due as (
         select array_agg(due_at order by due_at asc, id asc) as arr, now() as t,
                (select rental_duration_minutes from public.sessions where id = $1) as dur
           from public.rentals where session_id = $1 and status = 'OUT'
       )
       select
         public.estimated_wait_minutes($1, 1) as f1,
         public.estimated_wait_minutes($1, 2) as f2,
         public.estimated_wait_minutes($1, 3) as f3,
         public.estimated_wait_minutes($1, 4) as f4,
         greatest(0, ceil(extract(epoch from (arr[1] - t)) / 60))::int as e1,
         greatest(0, ceil(extract(epoch from (arr[2] - t)) / 60))::int as e2,
         greatest(0, ceil(extract(epoch from (arr[1] + make_interval(mins => dur) - t)) / 60))::int as e3,
         greatest(0, ceil(extract(epoch from (arr[2] + make_interval(mins => dur) - t)) / 60))::int as e4
       from due`,
      [sessionId],
    );
    const row = res.rows[0];
    expect(row.f1).toBe(row.e1);
    expect(row.f2).toBe(row.e2);
    expect(row.f3).toBe(row.e3); // beyond one full bin cycle
    expect(row.f4).toBe(row.e4);
  });

  it("returns zero remaining minutes for an overdue rental in its current cycle", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool, {
      rentalDurationMinutes: 60,
    });
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ra = await getReadyDetails(pool, a.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ra!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await forceOverdue(pool, sessionId, "1", 15);
    const res = await pool.query(
      `select public.estimated_wait_minutes($1, 1) as f1,
              public.estimated_wait_minutes($1, 2) as f2
       from public.sessions where id = $1`,
      [sessionId],
    );
    expect(res.rows[0].f1).toBe(0); // overdue -> zero this cycle
    expect(res.rows[0].f2).toBeGreaterThan(0); // next cycle still counts
  });

  it("returns NULL (unavailable) when no active rental exists", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    const res = await pool.query(
      `select public.estimated_wait_minutes($1, 1) as f1`,
      [sessionId],
    );
    expect(res.rows[0].f1).toBeNull();
  });
});
