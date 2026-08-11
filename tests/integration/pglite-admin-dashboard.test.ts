import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addBins,
  checkout,
  count,
  createMigratedDb,
  createSession,
  forceOverdue,
  getReadyDetails,
  joinQueue,
  type Db,
} from "./pglite/harness";

let db: Db;

beforeAll(async () => {
  db = await createMigratedDb();
});

describe("Ticket 4 admin PostgreSQL functions", () => {
  it("creates, configures, starts, and ends a session idempotently", async () => {
    const key = randomUUID();
    const first = await db.query<{
      result: {
        session: {
          id: string;
          status: string;
          student_code: string;
          staff_code: string;
        };
        idempotent_replay: boolean;
      };
    }>(`select public.admin_create_session($1, $2, $3, $4, $5, $6) as result`, [
      "Ticket 4",
      60,
      10,
      `signup-${key}`,
      `staff-${key}`,
      key,
    ]);
    const sessionId = first.rows[0].result.session.id;
    expect(first.rows[0].result).toMatchObject({
      session: {
        status: "DRAFT",
        student_code: `signup-${key}`,
        staff_code: `staff-${key}`,
      },
      idempotent_replay: false,
    });

    const replay = await db.query<{ result: { idempotent_replay: boolean } }>(
      `select public.admin_create_session($1, $2, $3, $4, $5, $6) as result`,
      ["Ticket 4", 60, 10, `signup-${key}`, `staff-${key}`, key],
    );
    expect(replay.rows[0].result.idempotent_replay).toBe(true);
    await expect(
      db.query(`select public.admin_create_session($1, $2, $3, $4, $5, $6)`, [
        "Different request",
        60,
        10,
        `signup-${key}`,
        `staff-${key}`,
        key,
      ]),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(
      await count(
        db,
        `select count(*)::int c from public.sessions where creation_idempotency_key = $1`,
        [key],
      ),
    ).toBe(1);

    const configured = await db.query<{
      result: {
        session: {
          rental_duration_minutes: number;
          pickup_window_minutes: number;
        };
      };
    }>(`select public.admin_configure_session($1, $2, $3) as result`, [
      sessionId,
      90,
      15,
    ]);
    expect(configured.rows[0].result.session).toMatchObject({
      rental_duration_minutes: 90,
      pickup_window_minutes: 15,
    });
    const configReplay = await db.query<{
      result: { idempotent_replay: boolean };
    }>(`select public.admin_configure_session($1, $2, $3) as result`, [
      sessionId,
      90,
      15,
    ]);
    expect(configReplay.rows[0].result.idempotent_replay).toBe(true);

    const started = await db.query<{ result: { session: { status: string } } }>(
      `select public.admin_start_session($1) as result`,
      [sessionId],
    );
    expect(started.rows[0].result.session.status).toBe("ACTIVE");
    const startReplay = await db.query<{
      result: { idempotent_replay: boolean };
    }>(`select public.admin_start_session($1) as result`, [sessionId]);
    expect(startReplay.rows[0].result.idempotent_replay).toBe(true);

    const ended = await db.query<{ result: { session: { status: string } } }>(
      `select public.admin_end_session($1) as result`,
      [sessionId],
    );
    expect(ended.rows[0].result.session.status).toBe("CLOSED");
    const endReplay = await db.query<{
      result: { idempotent_replay: boolean };
    }>(`select public.admin_end_session($1) as result`, [sessionId]);
    expect(endReplay.rows[0].result.idempotent_replay).toBe(true);
    await expect(
      db.query(`select public.admin_configure_session($1, 30, 5)`, [sessionId]),
    ).rejects.toThrow(/SESSION_CLOSED/);
  });

  it("adds a bulk bin set once, reports duplicates, and rejects invalid input", async () => {
    const sessionId = await createSession(db, { status: "DRAFT" });
    const first = await db.query<{
      result: { added: string[]; duplicates: string[] };
    }>(`select public.admin_add_bins($1, $2::text[]) as result`, [
      sessionId,
      ["1", "2", "3"],
    ]);
    expect(first.rows[0].result).toEqual({
      added: ["1", "2", "3"],
      duplicates: [],
    });

    const retry = await db.query<{
      result: { added: string[]; duplicates: string[] };
    }>(`select public.admin_add_bins($1, $2::text[]) as result`, [
      sessionId,
      ["1", "2", "3"],
    ]);
    expect(retry.rows[0].result).toEqual({
      added: [],
      duplicates: ["1", "2", "3"],
    });
    expect(
      await count(
        db,
        `select count(*)::int c from public.bins where session_id=$1`,
        [sessionId],
      ),
    ).toBe(3);
    await expect(
      db.query(`select public.admin_add_bins($1, $2::text[])`, [
        sessionId,
        ["4", "not-a-number"],
      ]),
    ).rejects.toThrow(/INVALID_ADMIN_INPUT/);
    expect(
      await count(
        db,
        `select count(*)::int c from public.bins where session_id=$1`,
        [sessionId],
      ),
    ).toBe(3);
  });

  it("queues on-time and overdue Notify intents idempotently and rejects cross-session rental IDs", async () => {
    const sessionId = await createSession(db);
    const otherSessionId = await createSession(db);
    await addBins(db, sessionId, ["1"]);
    const signup = await joinQueue(db, sessionId);
    const ready = await getReadyDetails(db, signup.queueEntryId);
    await checkout(db, {
      sessionId,
      pickupCode: ready!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    const rental = await db.query<{ id: string }>(
      `select id from public.rentals where session_id=$1 and status='OUT'`,
      [sessionId],
    );
    const rentalId = rental.rows[0].id;
    const key = randomUUID();
    const first = await db.query<{
      result: { outbox_id: string; body: string; idempotent_replay: boolean };
    }>(`select public.admin_notify_rental($1, $2, $3) as result`, [
      sessionId,
      rentalId,
      key,
    ]);
    expect(first.rows[0].result.body).toMatch(/minute(s)? remaining/);
    expect(first.rows[0].result.idempotent_replay).toBe(false);
    const replay = await db.query<{
      result: { outbox_id: string; idempotent_replay: boolean };
    }>(`select public.admin_notify_rental($1, $2, $3) as result`, [
      sessionId,
      rentalId,
      key,
    ]);
    expect(replay.rows[0].result).toMatchObject({
      outbox_id: first.rows[0].result.outbox_id,
      idempotent_replay: true,
    });
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='MANUAL'`,
        [sessionId],
      ),
    ).toBe(1);

    await expect(
      db.query(`select public.admin_notify_rental($1, $2, $3)`, [
        otherSessionId,
        rentalId,
        randomUUID(),
      ]),
    ).rejects.toThrow(/NO_ACTIVE_RENTAL/);
    await expect(
      db.query(`select public.admin_notify_rental($1, $2, $3)`, [
        otherSessionId,
        rentalId,
        key,
      ]),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    await forceOverdue(db, sessionId, "1", 7);
    const overdue = await db.query<{ result: { body: string } }>(
      `select public.admin_notify_rental($1, $2, $3) as result`,
      [sessionId, rentalId, randomUUID()],
    );
    expect(overdue.rows[0].result.body).toMatch(/minute(s)? overdue/);
  });
});
