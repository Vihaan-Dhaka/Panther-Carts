import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addBins,
  checkout,
  closePool,
  createSession,
  describeDb,
  forceOverdue,
  getPool,
  getReadyDetails,
  joinQueue,
} from "./helpers/db";

afterAll(async () => {
  await closePool();
});

describeDb("Ticket 4 admin dashboard on real PostgreSQL", () => {
  it("runs retry-safe session lifecycle and bulk-bin RPCs", async () => {
    const pool = getPool();
    const key = randomUUID();
    const created = await pool.query(
      `select public.admin_create_session($1, $2, $3, $4, $5, $6) as result`,
      ["Real PostgreSQL admin", 60, 10, `signup-${key}`, `staff-${key}`, key],
    );
    const sessionId = created.rows[0].result.session.id as string;
    const createReplay = await pool.query(
      `select public.admin_create_session($1, $2, $3, $4, $5, $6) as result`,
      ["Real PostgreSQL admin", 60, 10, `signup-${key}`, `staff-${key}`, key],
    );
    expect(createReplay.rows[0].result.idempotent_replay).toBe(true);

    const bins = await pool.query(
      `select public.admin_add_bins($1, $2::text[]) as result`,
      [sessionId, ["1", "2", "3"]],
    );
    expect(bins.rows[0].result.added).toEqual(["1", "2", "3"]);
    const binReplay = await pool.query(
      `select public.admin_add_bins($1, $2::text[]) as result`,
      [sessionId, ["1", "2", "3"]],
    );
    expect(binReplay.rows[0].result).toEqual({
      added: [],
      duplicates: ["1", "2", "3"],
    });

    await pool.query(`select public.admin_start_session($1)`, [sessionId]);
    const startReplay = await pool.query(
      `select public.admin_start_session($1) as result`,
      [sessionId],
    );
    expect(startReplay.rows[0].result.idempotent_replay).toBe(true);
    await pool.query(`select public.admin_end_session($1)`, [sessionId]);
    const endReplay = await pool.query(
      `select public.admin_end_session($1) as result`,
      [sessionId],
    );
    expect(endReplay.rows[0].result.idempotent_replay).toBe(true);
  });

  it("keeps every reporting source and Notify mutation session-scoped", async () => {
    const pool = getPool();
    const first = await createSession(pool);
    const second = await createSession(pool);
    await addBins(pool, first.sessionId, ["11"]);
    await addBins(pool, second.sessionId, ["22"]);

    const firstStudent = await joinQueue(pool, first.sessionId);
    const secondStudent = await joinQueue(pool, second.sessionId);
    const firstReady = await getReadyDetails(pool, firstStudent.queueEntryId);
    const secondReady = await getReadyDetails(pool, secondStudent.queueEntryId);
    await checkout(pool, {
      sessionId: first.sessionId,
      pickupCode: firstReady!.pickupCode,
      binNumber: "11",
      idempotencyKey: randomUUID(),
    });
    await checkout(pool, {
      sessionId: second.sessionId,
      pickupCode: secondReady!.pickupCode,
      binNumber: "22",
      idempotencyKey: randomUUID(),
    });
    await joinQueue(pool, first.sessionId);
    await joinQueue(pool, second.sessionId);
    await forceOverdue(pool, first.sessionId, "11", 5);

    for (const view of [
      "v_current_out_rentals",
      "v_current_late_rentals",
      "v_all_late_rentals",
      "v_inventory",
      "v_session_rentals",
      "v_current_waitlist",
    ]) {
      const rows = await pool.query(
        `select session_id from public.${view} where session_id = $1`,
        [first.sessionId],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((row) => row.session_id === first.sessionId)).toBe(
        true,
      );
    }

    const rental = await pool.query(
      `select id from public.rentals where session_id=$1 and status='OUT'`,
      [first.sessionId],
    );
    const rentalId = rental.rows[0].id as string;
    const key = randomUUID();
    const notified = await pool.query(
      `select public.admin_notify_rental($1, $2, $3) as result`,
      [first.sessionId, rentalId, key],
    );
    expect(notified.rows[0].result.body).toMatch(/overdue/);
    const replay = await pool.query(
      `select public.admin_notify_rental($1, $2, $3) as result`,
      [first.sessionId, rentalId, key],
    );
    expect(replay.rows[0].result.idempotent_replay).toBe(true);
    await expect(
      pool.query(`select public.admin_notify_rental($1, $2, $3)`, [
        second.sessionId,
        rentalId,
        randomUUID(),
      ]),
    ).rejects.toThrow(/NO_ACTIVE_RENTAL/);
  });
});
