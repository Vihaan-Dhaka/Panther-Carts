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

  it("creates one combined immediate-signup message and deduplicates allocation", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    await joinQueue(db, s);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='INITIAL'`,
        [s],
      ),
    ).toBe(1);
    // Re-running allocation must not create a separate READY notification.
    await db.query(`select public.allocate_bins($1)`, [s]);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='READY'`,
        [s],
      ),
    ).toBe(0);
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

describe("idempotency keys are bound to the request (review finding 1/2)", () => {
  async function checkedOutSession() {
    const s = await createSession(db);
    await addBins(db, s, ["1", "2"]);
    const a = await joinQueue(db, s);
    const ready = await getReadyDetails(db, a.queueEntryId);
    return { s, a, ready: ready! };
  }

  it("rejects a checkout key reused in a different session", async () => {
    const first = await checkedOutSession();
    const second = await checkedOutSession();
    const key = randomUUID();
    await checkout(db, {
      sessionId: first.s,
      pickupCode: first.ready.pickup_code,
      binNumber: first.ready.bin_number,
      idempotencyKey: key,
    });
    await expect(
      checkout(db, {
        sessionId: second.s,
        pickupCode: second.ready.pickup_code,
        binNumber: second.ready.bin_number,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    // Session two must NOT have received session one's rental.
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1`,
        [second.s],
      ),
    ).toBe(0);
    expect((await getEntry(db, second.a.queueEntryId)).status).toBe("READY");
  });

  it("rejects a checkout key reused with a different bin, and replays an identical request", async () => {
    const { s, ready } = await checkedOutSession();
    const key = randomUUID();
    const original = (await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: ready.bin_number,
      idempotencyKey: key,
    })) as { rental: { id: string } };

    await expect(
      checkout(db, {
        sessionId: s,
        pickupCode: ready.pickup_code,
        binNumber: ready.bin_number === "1" ? "2" : "1",
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    // The identical request still replays safely.
    const replay = (await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: ready.bin_number,
      idempotencyKey: key,
    })) as { rental: { id: string }; idempotent_replay: boolean };
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.rental.id).toBe(original.rental.id);
  });

  it("rejects a return key reused for a different bin and leaves that bin OUT", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1", "2"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s);
    const ra = (await getReadyDetails(db, a.queueEntryId))!;
    const rb = (await getReadyDetails(db, b.queueEntryId))!;
    await checkout(db, {
      sessionId: s,
      pickupCode: ra.pickup_code,
      binNumber: ra.bin_number,
      idempotencyKey: randomUUID(),
    });
    await checkout(db, {
      sessionId: s,
      pickupCode: rb.pickup_code,
      binNumber: rb.bin_number,
      idempotencyKey: randomUUID(),
    });

    const key = randomUUID();
    await returnRental(db, {
      sessionId: s,
      binNumber: ra.bin_number,
      idempotencyKey: key,
    });
    await expect(
      returnRental(db, {
        sessionId: s,
        binNumber: rb.bin_number,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    // The second bin must remain genuinely OUT, not reported as returned.
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals r join public.bins bn on bn.id=r.bin_id
          where r.session_id=$1 and bn.bin_number=$2 and r.status='OUT'`,
        [s, rb.bin_number],
      ),
    ).toBe(1);
  });

  it("rejects NULL and blank idempotency keys on checkout and return", async () => {
    const { s, ready } = await checkedOutSession();
    for (const key of [null, "   "]) {
      await expect(
        checkout(db, {
          sessionId: s,
          pickupCode: ready.pickup_code,
          binNumber: ready.bin_number,
          idempotencyKey: key,
        }),
      ).rejects.toThrow(/IDEMPOTENCY_KEY_REQUIRED/);
    }
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1`,
        [s],
      ),
    ).toBe(0);

    await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: ready.bin_number,
      idempotencyKey: randomUUID(),
    });
    for (const key of [null, "   "]) {
      await expect(
        returnRental(db, {
          sessionId: s,
          binNumber: ready.bin_number,
          idempotencyKey: key,
        }),
      ).rejects.toThrow(/IDEMPOTENCY_KEY_REQUIRED/);
    }
    // Nothing moved: rental still OUT, bin still OUT, entry still CHECKED_OUT.
    const state = await db.query<{
      rs: string;
      bs: string;
      qs: string;
    }>(
      `select r.status rs, bn.status bs, qe.status qs
         from public.rentals r
         join public.bins bn on bn.id = r.bin_id
         join public.queue_entries qe on qe.id = r.queue_entry_id
        where r.session_id = $1`,
      [s],
    );
    expect(state.rows[0]).toMatchObject({
      rs: "OUT",
      bs: "OUT",
      qs: "CHECKED_OUT",
    });
  });
});

describe("idempotent replay returns the complete original response", () => {
  it("replays the full checkout response including `swapped`", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1", "2"]);
    const a = await joinQueue(db, s);
    const ready = (await getReadyDetails(db, a.queueEntryId))!;
    // Deliberately take the OTHER bin so the original response has swapped=true.
    const otherBin = ready.bin_number === "1" ? "2" : "1";
    const key = randomUUID();

    const original = (await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: otherBin,
      idempotencyKey: key,
    })) as Record<string, unknown>;
    expect(original.swapped).toBe(true);
    expect(original.idempotent_replay).toBe(false);

    const replay = (await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: otherBin,
      idempotencyKey: key,
    })) as Record<string, unknown>;

    expect(replay.idempotent_replay).toBe(true);
    // Every other field must match the original response exactly.
    expect({ ...replay, idempotent_replay: false }).toEqual(original);
  });

  it("replays the reservation the original return created", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const b = await joinQueue(db, s); // waiting: will receive the freed bin
    const ready = (await getReadyDetails(db, a.queueEntryId))!;
    await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });

    const key = randomUUID();
    const original = (await returnRental(db, {
      sessionId: s,
      binNumber: "1",
      idempotencyKey: key,
    })) as Record<string, unknown>;
    // The original call handed the bin to B.
    expect(original.reservation).not.toBeNull();
    expect((await getEntry(db, b.queueEntryId)).status).toBe("READY");

    const replay = (await returnRental(db, {
      sessionId: s,
      binNumber: "1",
      idempotencyKey: key,
    })) as Record<string, unknown>;

    expect(replay.idempotent_replay).toBe(true);
    // Regression: this used to come back as null, so a retried request told the
    // caller no reservation was made when one had been.
    expect(replay.reservation).not.toBeNull();
    expect({ ...replay, idempotent_replay: false }).toEqual(original);
  });
});

describe("join_queue validates format server-side (review finding 3)", () => {
  it("rejects malformed email addresses via the RPC", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    for (const email of ["x", "no-at-sign.example", "a@b", "a@b."]) {
      await expect(
        db.query(
          `select public.join_queue($1,'Name','900',$2,'+15551110000',true)`,
          [s, email],
        ),
      ).rejects.toThrow(/INVALID_EMAIL/);
    }
    expect(
      await count(
        db,
        `select count(*)::int c from public.students where session_id=$1`,
        [s],
      ),
    ).toBe(0);
  });

  it("rejects malformed phone numbers via the RPC", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    for (const phone of ["+1", "1", "555", "", "abc", "+1234567890123456789"]) {
      await expect(
        db.query(
          `select public.join_queue($1,'Name','900','ok@example.edu',$2,true)`,
          [s, phone],
        ),
      ).rejects.toThrow(/INVALID_PHONE|INVALID_STUDENT_INPUT/);
    }
    expect(
      await count(
        db,
        `select count(*)::int c from public.students where session_id=$1`,
        [s],
      ),
    ).toBe(0);
  });

  it("refuses to store malformed values even by direct insert", async () => {
    const s = await createSession(db);
    await expect(
      db.query(
        `insert into public.students (session_id, full_name, panther_id, email, phone)
         values ($1,'N','900','x','+15551110000')`,
        [s],
      ),
    ).rejects.toThrow(/students_email_valid|violates check/i);
    await expect(
      db.query(
        `insert into public.students (session_id, full_name, panther_id, email, phone)
         values ($1,'N','900','ok@example.edu','+1')`,
        [s],
      ),
    ).rejects.toThrow(/students_phone_valid|violates check/i);
  });
});

describe("admin views expose the required student details (review finding 4)", () => {
  it("includes email and phone on late and session rental views", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = (await getReadyDetails(db, a.queueEntryId))!;
    await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await forceOverdue(db, s, "1", 30);

    const late = await db.query<{ email: string; phone: string }>(
      `select email, phone from public.v_all_late_rentals where session_id=$1`,
      [s],
    );
    expect(late.rows[0].email).toMatch(/@/);
    expect(late.rows[0].phone).toMatch(/^\+/);

    const all = await db.query<{ email: string; phone: string }>(
      `select email, phone from public.v_session_rentals where session_id=$1`,
      [s],
    );
    expect(all.rows[0].email).toMatch(/@/);
    expect(all.rows[0].phone).toMatch(/^\+/);
  });

  it("exposes the current occupant on the inventory view", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1", "2"]);
    const a = await joinQueue(db, s);
    const ready = (await getReadyDetails(db, a.queueEntryId))!;
    await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: ready.bin_number,
      idempotencyKey: randomUUID(),
    });

    const occupied = await db.query<{
      current_full_name: string | null;
      current_panther_id: string | null;
      current_email: string | null;
      current_phone: string | null;
    }>(
      `select current_full_name, current_panther_id, current_email, current_phone
         from public.v_inventory where session_id=$1 and bin_number=$2`,
      [s, ready.bin_number],
    );
    expect(occupied.rows[0].current_full_name).toBeTruthy();
    expect(occupied.rows[0].current_panther_id).toBeTruthy();
    expect(occupied.rows[0].current_email).toMatch(/@/);
    expect(occupied.rows[0].current_phone).toMatch(/^\+/);

    // A bin with no active rental reports no occupant.
    const free = await db.query<{ current_full_name: string | null }>(
      `select current_full_name from public.v_inventory
        where session_id=$1 and bin_number<>$2`,
      [s, ready.bin_number],
    );
    expect(free.rows[0].current_full_name).toBeNull();
  });
});

describe("PantherCard confirmation is NULL-safe (review finding 3)", () => {
  it("rejects NULL and FALSE confirmation on checkout without side effects", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = (await getReadyDetails(db, a.queueEntryId))!;

    for (const confirmation of [null, false]) {
      await expect(
        checkout(db, {
          sessionId: s,
          pickupCode: ready.pickup_code,
          binNumber: "1",
          panthercardCollected: confirmation,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/PANTHERCARD_REQUIRED/);
    }

    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1`,
        [s],
      ),
    ).toBe(0);
    // Bin still reserved, entry still READY, reservation still ACTIVE.
    expect((await getEntry(db, a.queueEntryId)).status).toBe("READY");
    expect(
      await count(
        db,
        `select count(*)::int c from public.bins where session_id=$1 and status='RESERVED'`,
        [s],
      ),
    ).toBe(1);
    expect(
      await count(
        db,
        `select count(*)::int c from public.reservations where session_id=$1 and status='ACTIVE'`,
        [s],
      ),
    ).toBe(1);
  });

  it("rejects NULL and FALSE confirmation on return without side effects", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = (await getReadyDetails(db, a.queueEntryId))!;
    await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });

    for (const confirmation of [null, false]) {
      await expect(
        returnRental(db, {
          sessionId: s,
          binNumber: "1",
          panthercardReturned: confirmation,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/PANTHERCARD_REQUIRED/);
    }

    const state = await db.query<{ rs: string; bs: string; qs: string }>(
      `select r.status rs, bn.status bs, qe.status qs
         from public.rentals r
         join public.bins bn on bn.id = r.bin_id
         join public.queue_entries qe on qe.id = r.queue_entry_id
        where r.session_id = $1`,
      [s],
    );
    expect(state.rows[0]).toMatchObject({
      rs: "OUT",
      bs: "OUT",
      qs: "CHECKED_OUT",
    });
  });
});

describe("session-consistency and phone invariants (review findings 6/7)", () => {
  it("refuses to store an unnormalized phone number", async () => {
    const s = await createSession(db);
    await expect(
      db.query(
        `insert into public.students (session_id, full_name, panther_id, email, phone)
         values ($1, 'X', '900', 'x@example.edu', '(404) 555-0123')`,
        [s],
      ),
    ).rejects.toThrow(/students_phone_normalized|violates check/i);
  });

  it("treats formatted and normalized forms of one number as the same student", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    await joinQueue(db, s, { phone: "(404) 555-7777" });
    await expect(joinQueue(db, s, { phone: "+14045557777" })).rejects.toThrow(
      /DUPLICATE_ACTIVE_ENTRY/,
    );
    expect(
      await count(
        db,
        `select count(*)::int c from public.queue_entries
          where session_id=$1 and status in ('WAITING','READY','CHECKED_OUT')`,
        [s],
      ),
    ).toBe(1);
  });

  it("rejects a queue entry that references another session's student", async () => {
    const owner = await createSession(db);
    const other = await createSession(db);
    const student = await db.query<{ id: string }>(
      `insert into public.students (session_id, full_name, panther_id, email, phone)
       values ($1, 'Y', '901', 'y@example.edu', '+15550001234') returning id`,
      [owner],
    );
    await expect(
      db.query(
        `insert into public.queue_entries (session_id, student_id, phone, status, queue_rank)
         values ($1, $2, '+15550001234', 'WAITING', 1)`,
        [other, student.rows[0].id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects a reservation that mixes sessions", async () => {
    // The owner session has no bins, so the entry stays WAITING with no active
    // reservation — isolating the composite foreign key from the
    // one-active-reservation-per-entry index.
    const owner = await createSession(db);
    const other = await createSession(db);
    await addBins(db, other, ["1"]);
    const a = await joinQueue(db, owner);
    expect(a.status).toBe("WAITING");
    const otherBin = await db.query<{ id: string }>(
      `select id from public.bins where session_id = $1`,
      [other],
    );
    await expect(
      db.query(
        `insert into public.reservations (session_id, queue_entry_id, bin_id, expires_at)
         values ($1, $2, $3, now() + interval '10 minutes')`,
        [owner, a.queueEntryId, otherBin.rows[0].id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("outbox deduplication actually deduplicates (review finding 8)", () => {
  it("keeps exactly one row when the same dedupe key is inserted twice", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const student = await db.query<{ student_id: string }>(
      `select student_id from public.queue_entries where id = $1`,
      [a.queueEntryId],
    );
    const studentId = student.rows[0].student_id;
    const key = `TEST-DEDUPE:${randomUUID()}`;

    const insertOnce = () =>
      db.query(
        `insert into public.notification_outbox (session_id, student_id, type, body, dedupe_key)
         values ($1, $2, 'MANUAL', 'hello', $3)
         on conflict (dedupe_key) do nothing`,
        [s, studentId, key],
      );

    await insertOnce();
    await insertOnce(); // second attempt is a genuine duplicate
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where dedupe_key=$1`,
        [key],
      ),
    ).toBe(1);
  });

  it("rejects a duplicate dedupe key when ON CONFLICT is not used", async () => {
    const s = await createSession(db);
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const student = await db.query<{ student_id: string }>(
      `select student_id from public.queue_entries where id = $1`,
      [a.queueEntryId],
    );
    const key = `TEST-UNIQUE:${randomUUID()}`;
    const raw = () =>
      db.query(
        `insert into public.notification_outbox (session_id, student_id, type, body, dedupe_key)
         values ($1, $2, 'MANUAL', 'hello', $3)`,
        [s, student.rows[0].student_id, key],
      );
    await raw();
    // Proves the unique constraint (not just the absence of a second attempt).
    await expect(raw()).rejects.toThrow(/duplicate key|unique/i);
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
    expect(res.rows[0].f2).toBe(60);
  });

  it("does not let a long-overdue rental erase later cycles", async () => {
    // Regression for the SQL side of review finding 5: with one rental 120
    // minutes overdue and a 60-minute duration, positions 1-3 previously all
    // returned 0. They must now return 0, 60, 120.
    const s = await createSession(db, { rentalDurationMinutes: 60 });
    await addBins(db, s, ["1"]);
    const a = await joinQueue(db, s);
    const ready = (await getReadyDetails(db, a.queueEntryId))!;
    await checkout(db, {
      sessionId: s,
      pickupCode: ready.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await forceOverdue(db, s, "1", 120);
    const res = await db.query<{ f1: number; f2: number; f3: number }>(
      `select public.estimated_wait_minutes($1,1) f1,
              public.estimated_wait_minutes($1,2) f2,
              public.estimated_wait_minutes($1,3) f3`,
      [s],
    );
    expect(res.rows[0].f1).toBe(0);
    expect(res.rows[0].f2).toBe(60);
    expect(res.rows[0].f3).toBe(120);
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
