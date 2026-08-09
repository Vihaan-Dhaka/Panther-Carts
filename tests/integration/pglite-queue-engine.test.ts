import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addBins,
  checkout,
  count,
  createMigratedDb,
  createSession,
  expireReservations,
  forceExpireActive,
  forceOverdue,
  getEntry,
  getReadyDetails,
  getWaitlist,
  hold,
  joinQueue,
  returnRental,
  type Db,
} from "./pglite/harness";

// Verifies the real migrations + queue-engine SQL in an in-process PostgreSQL
// (PGlite). Single-connection, so concurrency races are covered separately by
// the pg-driver suite against a real Supabase database.

let db: Db;

beforeAll(async () => {
  db = await createMigratedDb();
});

describe("schema constraints", () => {
  it("enforces unique bin numbers per session", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    await expect(addBins(db, s, ["1"])).rejects.toThrow(
      /duplicate key|bins_number_unique_per_session/i,
    );
  });

  it("rejects positive-duration violations", async () => {
    await expect(
      createSession(db, { rentalDurationMinutes: 0 }),
    ).rejects.toThrow(/sessions_rental_duration_positive|violates check/i);
  });

  it("has no bin-condition or QR columns anywhere", async () => {
    const res = await db.query(
      `select column_name from information_schema.columns
        where table_schema = 'public'
          and (lower(column_name) like '%condition%' or lower(column_name) like '%qr%')`,
    );
    expect(res.rows).toEqual([]);
  });

  it("enables RLS on every application table", async () => {
    const res = await db.query<{ relname: string }>(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`,
    );
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("join + allocation", () => {
  it("allocates an available bin immediately on join", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    expect(a.status).toBe("READY");
    expect(a.position).toBe(0);
    const ready = await getReadyDetails(db, a.queueEntryId);
    expect(ready?.pickup_code).toMatch(/^[0-9]{4}$/);
  });

  it("rejects a duplicate active entry for the same phone", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    await joinQueue(db, s, { phone: "+15551239999" });
    await expect(joinQueue(db, s, { phone: "+15551239999" })).rejects.toThrow(
      /DUPLICATE_ACTIVE_ENTRY/,
    );
  });

  it("rejects joining a session that is not ACTIVE", async () => {
    const s = await createSession(db, { status: "DRAFT" });
    await addBins(db, s, ["1"]);
    await expect(joinQueue(db, s)).rejects.toThrow(/SESSION_NOT_ACTIVE/);
  });

  it("preserves FIFO allocation order", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s); // READY
    const b = await joinQueue(db, s); // rank 1
    const c = await joinQueue(db, s); // rank 2
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await returnRental(db, {
      sessionId: s,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");
    expect((await getEntry(db, c.queueEntryId)).status).toBe("WAITING");
  });

  it("keeps waiting ranks contiguous", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    await joinQueue(db, s); // READY
    await joinQueue(db, s);
    await joinQueue(db, s);
    await joinQueue(db, s);
    const waitlist = await getWaitlist(db, s);
    expect(waitlist.map((w) => w.queue_rank)).toEqual([1, 2, 3]);
  });

  it("deduplicates outbox rows by dedupe_key", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    await joinQueue(db, s);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='READY'`,
        [s],
      ),
    ).toBe(1);
    // Re-running allocation must not create a second READY notification.
    await db.query(`select public.allocate_bins($1)`, [s]);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='READY'`,
        [s],
      ),
    ).toBe(1);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='INITIAL'`,
        [s],
      ),
    ).toBe(1);
  });
});

describe("HOLD", () => {
  it("produces waitlist C, A, D from A reserved with B, C, D waiting", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const c = await joinQueue(db, s);
    const d = await joinQueue(db, s);

    const result = await hold(db, s, a.queueEntryId);
    expect(result.position).toBe(2);
    expect(result.promoted_entry_id).toBe(b.queueEntryId);

    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");
    const aEntry = await getEntry(db, a.queueEntryId);
    expect(aEntry.status).toBe("WAITING");
    expect(aEntry.hold_used).toBe(true);

    const waitlist = await getWaitlist(db, s);
    expect(waitlist.map((w) => w.id)).toEqual([
      c.queueEntryId,
      a.queueEntryId,
      d.queueEntryId,
    ]);
    expect(waitlist.map((w) => w.queue_rank)).toEqual([1, 2, 3]);
  });

  it("makes A position one when only B is waiting", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const result = await hold(db, s, a.queueEntryId);
    expect(result.position).toBe(1);
    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");
    expect((await getWaitlist(db, s)).map((w) => w.id)).toEqual([
      a.queueEntryId,
    ]);
  });

  it("rejects HOLD when nobody is waiting", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    await expect(hold(db, s, a.queueEntryId)).rejects.toThrow(/NOBODY_WAITING/);
  });

  it("rejects a second HOLD from the same student", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s); // READY
    await joinQueue(db, s); // B waits
    await joinQueue(db, s); // E waits

    await hold(db, s, a.queueEntryId); // waitlist [E, A]; A.hold_used

    // Recycle the bin until A becomes READY again.
    await forceExpireActive(db, s);
    await expireReservations(db, s); // promote E; waitlist [A]
    await forceExpireActive(db, s);
    await expireReservations(db, s); // promote A -> READY again
    expect((await getEntry(db, a.queueEntryId)).status).toBe("READY");

    await joinQueue(db, s); // G waits so NOBODY_WAITING is not the reason
    await expect(hold(db, s, a.queueEntryId)).rejects.toThrow(
      /HOLD_ALREADY_USED/,
    );
  });
});

describe("checkout / return / expiration", () => {
  it("requires PantherCard return to complete a return", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await expect(
      returnRental(db, {
        sessionId: s,
        binNumber: "1",
        panthercardReturned: false,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/PANTHERCARD_REQUIRED/);
  });

  it("invalidates the pickup code after checkout", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    // Re-using the same code must fail: the entry is no longer READY.
    await expect(
      checkout(db, {
        sessionId: s,
        pickupCode: ready!.pickup_code,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/PICKUP_CODE_INVALID/);
  });

  it("is idempotent for return with the same key", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    const key = randomUUID();
    const first = (await returnRental(db, {
      sessionId: s,
      binNumber: "1",
      idempotencyKey: key,
    })) as { rental: { id: string } };
    const second = (await returnRental(db, {
      sessionId: s,
      binNumber: "1",
      idempotencyKey: key,
    })) as { rental: { id: string }; idempotent_replay: boolean };
    expect(second.idempotent_replay).toBe(true);
    expect(second.rental.id).toBe(first.rental.id);
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1`,
        [s],
      ),
    ).toBe(1);
  });

  it("makes expiration idempotent and safe to re-run", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    await forceExpireActive(db, s);
    expect(await expireReservations(db, s)).toBe(1);
    expect(await expireReservations(db, s)).toBe(0);
    expect((await getEntry(db, a.queueEntryId)).status).toBe("EXPIRED");
  });

  it("records was_late only when the return is actually late", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1", "2"]);
    const onTime = await joinQueue(db, s);
    const late = await joinQueue(db, s);
    const r1 = await getReadyDetails(db, onTime.queueEntryId);
    const r2 = await getReadyDetails(db, late.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: r1!.pickup_code,
      binNumber: r1!.bin_number,
      idempotencyKey: randomUUID(),
    });
    await checkout(db, {
      sessionId: s,
      pickupCode: r2!.pickup_code,
      binNumber: r2!.bin_number,
      idempotencyKey: randomUUID(),
    });
    await forceOverdue(db, s, r2!.bin_number, 5);
    const onTimeResult = (await returnRental(db, {
      sessionId: s,
      binNumber: r1!.bin_number,
      idempotencyKey: randomUUID(),
    })) as { rental: { was_late: boolean } };
    const lateResult = (await returnRental(db, {
      sessionId: s,
      binNumber: r2!.bin_number,
      idempotencyKey: randomUUID(),
    })) as { rental: { was_late: boolean } };
    expect(onTimeResult.rental.was_late).toBe(false);
    expect(lateResult.rental.was_late).toBe(true);
  });
});

describe("duplicate-prevention guards (serialized)", () => {
  // PGlite is single-connection, so these run the two operations sequentially.
  // The session advisory lock serializes real concurrent calls into exactly
  // this order, so the guard logic proven here is what makes the true-race
  // tests (pg-driver suite) hold. True multi-connection races: concurrency.test.ts.

  it("a second checkout on the same pickup code cannot create a duplicate rental", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await expect(
      checkout(db, {
        sessionId: s,
        pickupCode: ready!.pickup_code,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/PICKUP_CODE_INVALID/);
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1`,
        [s],
      ),
    ).toBe(1);
  });

  it("a second return on the same bin cannot reserve the next student twice", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await returnRental(db, {
      sessionId: s,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await expect(
      returnRental(db, {
        sessionId: s,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/NO_ACTIVE_RENTAL/);
    expect(
      await count(
        db,
        `select count(*)::int c from public.reservations where session_id=$1 and status='ACTIVE'`,
        [s],
      ),
    ).toBe(1);
    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");
  });

  it("HOLD before checkout: HOLD wins and the stale pickup code is rejected", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await hold(db, s, a.queueEntryId);
    await expect(
      checkout(db, {
        sessionId: s,
        pickupCode: ready!.pickup_code,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/PICKUP_CODE_INVALID/);
    expect((await getEntry(db, a.queueEntryId)).status).toBe("WAITING");
    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1`,
        [s],
      ),
    ).toBe(0);
  });

  it("checkout before HOLD: checkout wins and HOLD is rejected", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await expect(hold(db, s, a.queueEntryId)).rejects.toThrow(
      /ENTRY_NOT_READY/,
    );
    expect((await getEntry(db, a.queueEntryId)).status).toBe("CHECKED_OUT");
    expect((await getEntry(db, b.queueEntryId)).status).toBe("WAITING");
  });

  it("HOLD on an expired reservation is rejected; expiration then promotes B", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    await forceExpireActive(db, s);
    await expect(hold(db, s, a.queueEntryId)).rejects.toThrow(
      /RESERVATION_EXPIRED/,
    );
    await expireReservations(db, s);
    expect((await getEntry(db, a.queueEntryId)).status).toBe("EXPIRED");
    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");
  });
});

describe("estimated wait", () => {
  it("matches the sorted-return algorithm across cycles", async () => {
    const s = await createSession(db, { rentalDurationMinutes: 60 });
    await addBins(db, s, ["1", "2"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const ra = await getReadyDetails(db, a.queueEntryId);
    const rb = await getReadyDetails(db, b.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ra!.pickup_code,
      binNumber: ra!.bin_number,
      idempotencyKey: randomUUID(),
    });
    await checkout(db, {
      sessionId: s,
      pickupCode: rb!.pickup_code,
      binNumber: rb!.bin_number,
      idempotencyKey: randomUUID(),
    });
    await db.query(
      `update public.rentals set due_at = now() + interval '10 minutes'
        where session_id=$1 and bin_id=(select id from public.bins where session_id=$1 and bin_number=$2)`,
      [s, ra!.bin_number],
    );
    await db.query(
      `update public.rentals set due_at = now() + interval '40 minutes'
        where session_id=$1 and bin_id=(select id from public.bins where session_id=$1 and bin_number=$2)`,
      [s, rb!.bin_number],
    );

    const res = await db.query<{
      f1: number;
      f2: number;
      f3: number;
      f4: number;
      e1: number;
      e2: number;
      e3: number;
      e4: number;
    }>(
      `with due as (
         select array_agg(due_at order by due_at asc, id asc) as arr, now() as t,
                (select rental_duration_minutes from public.sessions where id=$1) as dur
           from public.rentals where session_id=$1 and status='OUT'
       )
       select
         public.estimated_wait_minutes($1,1) f1,
         public.estimated_wait_minutes($1,2) f2,
         public.estimated_wait_minutes($1,3) f3,
         public.estimated_wait_minutes($1,4) f4,
         greatest(0, ceil(extract(epoch from (arr[1]-t))/60))::int e1,
         greatest(0, ceil(extract(epoch from (arr[2]-t))/60))::int e2,
         greatest(0, ceil(extract(epoch from (arr[1]+make_interval(mins=>dur)-t))/60))::int e3,
         greatest(0, ceil(extract(epoch from (arr[2]+make_interval(mins=>dur)-t))/60))::int e4
       from due`,
      [s],
    );
    const row = res.rows[0];
    expect(row.f1).toBe(row.e1);
    expect(row.f2).toBe(row.e2);
    expect(row.f3).toBe(row.e3); // beyond one full bin cycle
    expect(row.f4).toBe(row.e4);
  });

  it("returns zero for an overdue rental in its current cycle", async () => {
    const s = await createSession(db, { rentalDurationMinutes: 60 });
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    await checkout(db, {
      sessionId: s,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await forceOverdue(db, s, "1", 15);
    const res = await db.query<{ f1: number; f2: number }>(
      `select public.estimated_wait_minutes($1,1) f1, public.estimated_wait_minutes($1,2) f2`,
      [s],
    );
    expect(res.rows[0].f1).toBe(0);
    expect(res.rows[0].f2).toBeGreaterThan(0);
  });

  it("returns NULL when no active rental exists", async () => {
    const s = await createSession(db);
    const res = await db.query<{ f1: number | null }>(
      `select public.estimated_wait_minutes($1,1) f1`,
      [s],
    );
    expect(res.rows[0].f1).toBeNull();
  });
});
