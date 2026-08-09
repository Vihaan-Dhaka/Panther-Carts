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
  getEntry,
  getPool,
  getReadyDetails,
  hold,
  joinQueue,
  returnRental,
} from "./helpers/db";

afterAll(async () => {
  await closePool();
});

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

describeDb("concurrency", () => {
  it("two simultaneous checkouts cannot create duplicate rentals", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId);
    const ready = await getReadyDetails(pool, a.queueEntryId);

    const results = await Promise.allSettled([
      checkout(pool, {
        sessionId,
        pickupCode: ready!.pickupCode,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
      checkout(pool, {
        sessionId,
        pickupCode: ready!.pickupCode,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(await countRentals(sessionId)).toBe(1);
    expect((await getEntry(pool, a.queueEntryId)).status).toBe("CHECKED_OUT");
  });

  it("two simultaneous returns cannot reserve the same student twice", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY
    const b = await joinQueue(pool, sessionId); // waiting
    const ready = await getReadyDetails(pool, a.queueEntryId);
    await checkout(pool, {
      sessionId,
      pickupCode: ready!.pickupCode,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });

    const results = await Promise.allSettled([
      returnRental(pool, {
        sessionId,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
      returnRental(pool, {
        sessionId,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The freed bin is offered to B exactly once.
    expect(await countActiveReservations(sessionId)).toBe(1);
    expect((await getEntry(pool, b.queueEntryId)).status).toBe("READY");
  });

  it("HOLD racing checkout yields exactly one valid outcome", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY
    const b = await joinQueue(pool, sessionId); // waiting
    const ready = await getReadyDetails(pool, a.queueEntryId);

    await Promise.allSettled([
      hold(pool, sessionId, a.queueEntryId),
      checkout(pool, {
        sessionId,
        pickupCode: ready!.pickupCode,
        binNumber: "1",
        idempotencyKey: randomUUID(),
      }),
    ]);

    const aEntry = await getEntry(pool, a.queueEntryId);
    const bEntry = await getEntry(pool, b.queueEntryId);
    const rentals = await countRentals(sessionId);

    const checkoutWon =
      rentals === 1 &&
      aEntry.status === "CHECKED_OUT" &&
      bEntry.status === "WAITING";
    const holdWon =
      rentals === 0 &&
      aEntry.status === "WAITING" &&
      aEntry.hold_used === true &&
      bEntry.status === "READY";

    // Exactly one of the two mutually exclusive outcomes must hold.
    expect(checkoutWon !== holdWon).toBe(true);
    expect(await countActiveReservations(sessionId)).toBe(1);
  });

  it("HOLD racing expiration yields exactly one valid outcome", async () => {
    const pool = getPool();
    const { sessionId } = await createSession(pool);
    await addBins(pool, sessionId, ["1"]);
    const a = await joinQueue(pool, sessionId); // READY
    const b = await joinQueue(pool, sessionId); // waiting
    // Push A's reservation past its expiry so expiration is applicable.
    await forceExpireActiveReservations(pool, sessionId);

    await Promise.allSettled([
      hold(pool, sessionId, a.queueEntryId),
      expireReservations(pool, sessionId),
    ]);

    const aEntry = await getEntry(pool, a.queueEntryId);
    const bEntry = await getEntry(pool, b.queueEntryId);

    // An expired reservation can never be held, so expiration is the single
    // valid result: A expires and the bin is offered to B exactly once.
    expect(aEntry.status).toBe("EXPIRED");
    expect(bEntry.status).toBe("READY");
    expect(await countActiveReservations(sessionId)).toBe(1);
    expect(await countRentals(sessionId)).toBe(0);
  });
});
