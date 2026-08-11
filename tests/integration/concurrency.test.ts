import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  addBins,
  checkout,
  closePool,
  createSession,
  describeDb,
  expireReservations,
  forceExpireActiveReservations,
  getEntry,
  getPool,
  getReadyDetails,
  hold,
  isStillPending,
  joinQueue,
  returnRental,
} from "./helpers/db";

/**
 * Real-PostgreSQL concurrency proofs. These require a live database
 * (DATABASE_URL); PGlite cannot host them because it is single-connection.
 *
 * Two complementary techniques are used:
 *
 * 1. Advisory-lock blocking proof — connection 1 opens a transaction and takes
 *    `public.lock_session(...)`. Every mutation dispatched on OTHER connections
 *    must then BLOCK. We assert it is still pending, release the lock, and
 *    assert exactly one valid final state. This proves the mutations really do
 *    serialize on the same session key rather than merely happening to run
 *    sequentially, and it would fail if the lock were removed or keyed
 *    inconsistently.
 *
 * 2. Deterministic ordering — HOLD-wins and expiration-wins are each forced
 *    explicitly, so both outcomes are proven rather than whichever the
 *    scheduler happened to pick.
 */

afterAll(async () => {
  await closePool();
});

/** Open a transaction on a dedicated connection and hold the session lock. */
async function holdSessionLock(sessionId: string): Promise<PoolClient> {
  const client = await getPool().connect();
  await client.query("begin");
  await client.query("select public.lock_session($1)", [sessionId]);
  return client;
}

async function countRentals(sessionId: string): Promise<number> {
  const res = await getPool().query(
    `select count(*)::int as c from public.rentals where session_id = $1`,
    [sessionId],
  );
  return res.rows[0].c as number;
}

async function countActiveReservations(sessionId: string): Promise<number> {
  const res = await getPool().query(
    `select count(*)::int as c from public.reservations
      where session_id = $1 and status = 'ACTIVE'`,
    [sessionId],
  );
  return res.rows[0].c as number;
}

async function countOutbox(sessionId: string, type: string): Promise<number> {
  const res = await getPool().query(
    `select count(*)::int as c from public.notification_outbox
      where session_id = $1 and type = $2`,
    [sessionId, type],
  );
  return res.rows[0].c as number;
}

describeDb("session advisory lock actually serializes mutations", () => {
  it("blocks checkout on another connection until the lock is released", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);

    const locker = await holdSessionLock(sessionId);
    try {
      const pending = checkout(pool, {
        sessionId,
        pickupCode: ready!.pickupCode,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      });
      // Must be blocked by the session lock, not racing past it.
      expect(await isStillPending(pending)).toBe(true);

      await locker.query("commit");
      await pending; // proceeds once the lock is released
      expect(await countRentals(sessionId)).toBe(1);
    } finally {
      locker.release();
    }
  });

  it("blocks return and HOLD on the same session key", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });

    const locker = await holdSessionLock(sessionId);
    try {
      const pendingReturn = returnRental(pool, {
        sessionId,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      });
      expect(await isStillPending(pendingReturn)).toBe(true);
      await locker.query("commit");
      await pendingReturn;
    } finally {
      locker.release();
    }
    // The freed bin went to B exactly once.
    expect(await countActiveReservations(sessionId)).toBe(1);
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
  });

  it("does not block a different session (lock is keyed per session)", async () => {
    const pool = getPool();
    const locked = await createSession(pool);
    const other = await createSession(pool);
    await addBins(pool, other.sessionId, ["1"]);

    const locker = await holdSessionLock(locked.sessionId);
    try {
      // A mutation in an unrelated session must proceed immediately.
      const join = joinQueue(pool, other.sessionId);
      expect(await isStillPending(join)).toBe(false);
      await join;
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  });
});

describeDb("concurrent duplicate prevention", () => {
  it("two simultaneous checkouts cannot create duplicate rentals", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);

    // Queue both behind the lock so they are genuinely in flight together.
    const locker = await holdSessionLock(sessionId);
    const first = checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    const second = checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    expect(await isStillPending(first)).toBe(true);
    expect(await isStillPending(second)).toBe(true);
    await locker.query("commit");
    locker.release();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countRentals(sessionId)).toBe(1);
    expect((await getEntry(pool, a.queueEntryId)).status).toBe("CHECKED_OUT");
  });

  it("two simultaneous returns cannot reserve the same student twice", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });

    const locker = await holdSessionLock(sessionId);
    const first = returnRental(pool, {
      sessionId,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    const second = returnRental(pool, {
      sessionId,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    expect(await isStillPending(first)).toBe(true);
    await locker.query("commit");
    locker.release();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countActiveReservations(sessionId)).toBe(1);
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    // B was offered the bin exactly once.
    expect(await countOutbox(sessionId, "READY")).toBe(2); // A's original + B's
  });
});

describeDb("HOLD races produce exactly one valid outcome", () => {
  it("HOLD wins when it commits first (reservation still valid)", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);

    await hold(pool, sessionId, a.queueEntryId);
    // The losing checkout must now fail: A's code was invalidated by HOLD.
    await expect(
      checkout(pool, {
        sessionId,
        pickupCode: ready!.pickupCode,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/PICKUP_CODE_INVALID/);

    const aEntry = await getEntry(pool, a.queueEntryId);
    expect(aEntry.status).toBe("WAITING");
    expect(aEntry.hold_used).toBe(true);
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    expect(await countRentals(sessionId)).toBe(0);
    expect(await countActiveReservations(sessionId)).toBe(1);
  });

  it("checkout wins when it commits first (HOLD then rejected)", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);

    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    await expect(hold(pool, sessionId, a.queueEntryId)).rejects.toThrow(
      /ENTRY_NOT_READY/,
    );

    expect((await getEntry(pool, a.queueEntryId)).status).toBe("CHECKED_OUT");
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("WAITING");
    expect(await countRentals(sessionId)).toBe(1);
  });

  it("HOLD wins over expiration when the reservation is still unexpired", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);

    // Reservation is NOT expired, so HOLD is the valid outcome and a
    // concurrent expiration sweep must find nothing to expire.
    const result = await hold(pool, sessionId, a.queueEntryId);
    expect(result.position).toBe(1);
    expect(await expireReservations(pool, sessionId)).toBe(0);

    expect((await getEntry(pool, a.queueEntryId)).status).toBe("WAITING");
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    expect(await countActiveReservations(sessionId)).toBe(1);
  });

  it("expiration wins once the reservation has lapsed (HOLD rejected)", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);
    await forceExpireActiveReservations(pool, sessionId);

    // An expired reservation can never be held.
    await expect(hold(pool, sessionId, a.queueEntryId)).rejects.toThrow(
      /RESERVATION_EXPIRED/,
    );
    expect(await expireReservations(pool, sessionId)).toBe(1);

    expect((await getEntry(pool, a.queueEntryId)).status).toBe("EXPIRED");
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
    expect(await countActiveReservations(sessionId)).toBe(1);
    expect(await countRentals(sessionId)).toBe(0);
  });

  it("concurrent HOLD and expiration settle to exactly one valid state", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const b = await joinQueue(pool, sessionId);

    // Both dispatched while the lock is held: whichever acquires it first wins,
    // and the other must observe the resulting state consistently.
    const locker = await holdSessionLock(sessionId);
    const holdCall = hold(pool, sessionId, a.queueEntryId);
    const expireCall = expireReservations(pool, sessionId);
    expect(await isStillPending(holdCall)).toBe(true);
    await locker.query("commit");
    locker.release();
    await Promise.allSettled([holdCall, expireCall]);

    const aEntry = await getEntry(pool, a.queueEntryId);
    const bEntry = await getEntry(pool, b.queueEntryId);
    const holdWon = aEntry.status === "WAITING" && aEntry.hold_used === true;
    const expiryWon = aEntry.status === "EXPIRED";
    expect(holdWon !== expiryWon).toBe(true); // exactly one
    expect(bEntry.status).toBe("READY"); // B is promoted either way
    expect(await countActiveReservations(sessionId)).toBe(1);
    expect(await countRentals(sessionId)).toBe(0);
  });
});

describeDb("idempotency is bound to the request", () => {
  it("rejects a checkout key reused in another session", async () => {
    const pool = getPool();
    const first = await createSession(pool);
    const second = await createSession(pool);
    await addBins(pool, first.sessionId, ["1"]);
    await addBins(pool, second.sessionId, ["1"]);
    const a = await joinQueue(pool, first.sessionId);
    const b = await joinQueue(pool, second.sessionId);
    const ra = await getReadyDetails(pool, a.queueEntryId);
    const rb = await getReadyDetails(pool, b.queueEntryId);

    const sharedKey = randomUUID();
    await checkout(pool, {
      sessionId: first.sessionId,
      pickupCode: ra!.pickupCode,
      binNumber: "1",
      idempotencyKey: sharedKey,
    });
    await expect(
      checkout(pool, {
        sessionId: second.sessionId,
        pickupCode: rb!.pickupCode,
        binNumber: "1",
        idempotencyKey: sharedKey,
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    // Session two must not have been given session one's rental.
    expect(await countRentals(second.sessionId)).toBe(0);
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
  });

  it("two simultaneous checkouts in different sessions with one key give a clean conflict", async () => {
    // Regression: the session lock cannot serialize these (different sessions),
    // so both used to pass the key lookup and one surfaced a raw
    // unique-constraint error instead of IDEMPOTENCY_CONFLICT.
    const pool = getPool();
    const first = await createSession(pool);
    const second = await createSession(pool);
    await addBins(pool, first.sessionId, ["1"]);
    await addBins(pool, second.sessionId, ["1"]);
    const a = await joinQueue(pool, first.sessionId);
    const b = await joinQueue(pool, second.sessionId);
    const ra = await getReadyDetails(pool, a.queueEntryId);
    const rb = await getReadyDetails(pool, b.queueEntryId);

    // Force genuine overlap: park each call behind its OWN session lock, then
    // release both at once so they enter the key lookup simultaneously. Simply
    // dispatching two promises is not enough — the first usually finishes
    // before the second starts, and the race never happens.
    const sharedKey = randomUUID();
    const lockA = await holdSessionLock(first.sessionId);
    const lockB = await holdSessionLock(second.sessionId);

    const callA = checkout(pool, {
      sessionId: first.sessionId,
      pickupCode: ra!.pickupCode,
      binNumber: "1",
      idempotencyKey: sharedKey,
    });
    const callB = checkout(pool, {
      sessionId: second.sessionId,
      pickupCode: rb!.pickupCode,
      binNumber: "1",
      idempotencyKey: sharedKey,
    });
    expect(await isStillPending(callA)).toBe(true);
    expect(await isStillPending(callB)).toBe(true);

    await Promise.all([lockA.query("commit"), lockB.query("commit")]);
    lockA.release();
    lockB.release();

    const results = await Promise.allSettled([callA, callB]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser must get the domain error, never a raw 23505 unique violation.
    const reason = String(
      (rejected[0] as PromiseRejectedResult).reason?.message ?? "",
    );
    expect(reason).toMatch(/IDEMPOTENCY_CONFLICT/);
    expect(reason).not.toMatch(/duplicate key|unique constraint/i);

    // Exactly one rental exists across both sessions.
    const total =
      (await countRentals(first.sessionId)) +
      (await countRentals(second.sessionId));
    expect(total).toBe(1);
  });

  it("two simultaneous identical checkouts both return the same complete response", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);
    const key = randomUUID();

    const args = {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: key,
    };
    const [first, second] = await Promise.all([
      checkout(pool, args),
      checkout(pool, args),
    ]);

    // One is the original, one a replay, but the payloads must agree.
    expect(first.rental.id).toBe(second.rental.id);
    expect(first.swapped).toBe(second.swapped);
    expect(await countRentals(sessionId)).toBe(1);
  });
});
