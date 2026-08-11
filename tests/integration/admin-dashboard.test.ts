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
  isStillPending,
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
      `select public.admin_create_session($1, $2, $3, $4) as result`,
      ["Real PostgreSQL admin", 60, 10, key],
    );
    const sessionId = created.rows[0].result.session.id as string;
    expect(created.rows[0].result.session.student_code).toMatch(
      /^signup-[a-f0-9]{32}$/,
    );
    expect(created.rows[0].result.session.staff_code).toMatch(
      /^staff-[a-f0-9]{32}$/,
    );
    const createReplay = await pool.query(
      `select public.admin_create_session($1, $2, $3, $4) as result`,
      ["Real PostgreSQL admin", 60, 10, key],
    );
    expect(createReplay.rows[0].result.idempotent_replay).toBe(true);
    await expect(
      pool.query(`select public.admin_create_session($1, $2, $3, $4)`, [
        "Second browser tab",
        60,
        10,
        randomUUID(),
      ]),
    ).rejects.toThrow(/SESSION_ALREADY_OPEN/);

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

  it("serializes two dashboard creates and gives the loser a clean domain error", async () => {
    const pool = getPool();
    const firstClient = await pool.connect();
    let committed = false;
    let sessionId = "";
    try {
      await firstClient.query("begin");
      const first = await firstClient.query(
        `select public.admin_create_session($1, $2, $3, $4) as result`,
        ["First tab", 60, 10, randomUUID()],
      );
      sessionId = first.rows[0].result.session.id as string;

      // The first row and singleton advisory lock remain uncommitted. A second
      // browser request must wait; after commit it must recheck and return the
      // domain error. Without the singleton lock it instead waits on the unique
      // index and then surfaces a raw duplicate-key violation deterministically.
      const competing = pool.query(
        `select public.admin_create_session($1, $2, $3, $4) as result`,
        ["Second tab", 60, 10, randomUUID()],
      );
      const wasPending = await isStillPending(competing);
      await firstClient.query("commit");
      committed = true;

      const [result] = await Promise.allSettled([competing]);
      expect(wasPending).toBe(true);
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error(
          "Expected the competing session creation to be rejected",
        );
      }
      const reason = String(result.reason?.message ?? result.reason);
      expect(reason).toMatch(/SESSION_ALREADY_OPEN/);
      expect(reason).not.toMatch(/duplicate key|unique constraint/i);
    } finally {
      if (!committed) await firstClient.query("rollback");
      firstClient.release();
    }

    await pool.query(`select public.admin_start_session($1)`, [sessionId]);
    await pool.query(`select public.admin_end_session($1)`, [sessionId]);
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
    await pool.query(`select public.admin_end_session($1)`, [first.sessionId]);
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
