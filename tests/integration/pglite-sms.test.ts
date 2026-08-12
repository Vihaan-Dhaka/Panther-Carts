import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { analyzeSmsSegments } from "@/lib/sms/gsm";
import {
  addBins,
  checkout,
  count,
  createMigratedDb,
  createSession,
  getEntry,
  getReadyDetails,
  getWaitlist,
  joinQueue,
  type Db,
} from "./pglite/harness";

let db: Db;

beforeEach(async () => {
  db = await createMigratedDb();
});

async function inbound(input: {
  providerEventId?: string;
  providerMessageId?: string;
  from: string;
  command: "TIME" | "HOLD" | "CANCEL" | "UNKNOWN";
  compliance?: "STOP" | "START" | "HELP" | null;
}) {
  const eventId = input.providerEventId ?? randomUUID();
  const messageId = input.providerMessageId ?? randomUUID();
  const result = await db.query<{ result: Record<string, unknown> }>(
    `select public.handle_inbound_sms(
      'telnyx', $1, $2, $3, '+14045550100', now(), $4, $5
    ) as result`,
    [eventId, messageId, input.from, input.command, input.compliance ?? null],
  );
  return result.rows[0].result;
}

describe("Ticket 5 signup notifications and consent", () => {
  it("keeps authoritative SQL templates in one GSM-7 segment at boundaries", async () => {
    const templates = await db.query<{ body: string }>(
      `select body from (values
        (public.sms_ready_body('9999',240)),
        (public.sms_signup_waiting_body(999999,999999)),
        (public.sms_signup_waiting_body(999999,null)),
        (public.sms_hold_body(999999)),
        (public.sms_time_waiting_body(999999,999999)),
        (public.sms_time_waiting_body(999999,null))
      ) as messages(body)`,
    );
    for (const { body } of templates.rows) {
      expect(analyzeSmsSegments(body), body).toMatchObject({
        encoding: "GSM-7",
        segments: 1,
      });
    }
  });

  it("requires consent and stores only timestamp plus disclosure version", async () => {
    const sessionId = await createSession(db);
    await expect(
      db.query(
        `select public.join_queue($1,'Student','9001','s@example.edu','+14045550123',false)`,
        [sessionId],
      ),
    ).rejects.toThrow(/SMS_CONSENT_REQUIRED/);

    const joined = await joinQueue(db, sessionId, { phone: "+14045550123" });
    const evidence = await db.query<{
      sms_consent_at: string | null;
      sms_consent_version: string | null;
    }>(
      `select s.sms_consent_at, s.sms_consent_version
       from public.students s
       join public.queue_entries qe on qe.student_id = s.id
       where qe.id = $1`,
      [joined.queueEntryId],
    );
    expect(evidence.rows[0].sms_consent_at).not.toBeNull();
    expect(evidence.rows[0].sms_consent_version).toBe(
      "2026-08-11.transactional-v1",
    );
  });

  it("creates one waiting signup message and one combined immediate-ready message", async () => {
    const waitingSession = await createSession(db);
    await joinQueue(db, waitingSession);
    const waiting = await db.query<{ type: string; body: string }>(
      `select type::text, body from public.notification_outbox where session_id=$1`,
      [waitingSession],
    );
    expect(waiting.rows).toHaveLength(1);
    expect(waiting.rows[0]).toMatchObject({ type: "INITIAL" });
    expect(waiting.rows[0].body).toContain("Joined. #1; wait TBD.");

    const readySession = await createSession(db);
    await addBins(db, readySession, ["1"]);
    await joinQueue(db, readySession);
    const ready = await db.query<{ type: string; body: string }>(
      `select type::text, body from public.notification_outbox where session_id=$1`,
      [readySession],
    );
    expect(ready.rows).toHaveLength(1);
    expect(ready.rows[0].type).toBe("INITIAL");
    expect(ready.rows[0].body).toContain("Cart ready. Code");
  });

  it("creates READY only when a later allocation occurs", async () => {
    const sessionId = await createSession(db);
    await joinQueue(db, sessionId);
    await addBins(db, sessionId, ["1"]);
    await db.query(`select public.allocate_bins($1)`, [sessionId]);
    const rows = await db.query<{ type: string }>(
      `select type::text from public.notification_outbox where session_id=$1 order by created_at,id`,
      [sessionId],
    );
    expect(rows.rows.map((row) => row.type).sort()).toEqual([
      "INITIAL",
      "READY",
    ]);
  });
});

describe("authoritative CANCEL", () => {
  it("cancels WAITING atomically, reindexes ranks, and replays idempotently", async () => {
    const sessionId = await createSession(db);
    const a = await joinQueue(db, sessionId);
    const b = await joinQueue(db, sessionId);
    const c = await joinQueue(db, sessionId);
    const key = randomUUID();
    const first = await db.query<{ result: Record<string, unknown> }>(
      `select public.cancel_queue_entry($1,$2,$3) as result`,
      [sessionId, b.queueEntryId, key],
    );
    expect(first.rows[0].result.outcome).toBe("WAITING_CANCELLED");
    expect((await getEntry(db, b.queueEntryId)).status).toBe("CANCELLED");
    expect((await getWaitlist(db, sessionId)).map((row) => row.id)).toEqual([
      a.queueEntryId,
      c.queueEntryId,
    ]);
    expect(
      (await getWaitlist(db, sessionId)).map((row) => row.queue_rank),
    ).toEqual([1, 2]);

    const replay = await db.query<{ result: Record<string, unknown> }>(
      `select public.cancel_queue_entry($1,$2,$3) as result`,
      [sessionId, b.queueEntryId, key],
    );
    expect(replay.rows[0].result.idempotent_replay).toBe(true);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where dedupe_key=$1`,
        [`CANCEL:${key}`],
      ),
    ).toBe(1);
    await expect(
      db.query(`select public.cancel_queue_entry($1,$2,$3)`, [
        sessionId,
        c.queueEntryId,
        key,
      ]),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("cancels READY, frees the reservation, and immediately offers the bin to next", async () => {
    const sessionId = await createSession(db);
    await addBins(db, sessionId, ["1"]);
    const ready = await joinQueue(db, sessionId);
    const waiting = await joinQueue(db, sessionId);
    await db.query(`select public.cancel_queue_entry($1,$2,$3)`, [
      sessionId,
      ready.queueEntryId,
      randomUUID(),
    ]);

    expect((await getEntry(db, ready.queueEntryId)).status).toBe("CANCELLED");
    expect((await getEntry(db, waiting.queueEntryId)).status).toBe("READY");
    const state = await db.query<{
      bin_status: string;
      old_reservation: string;
    }>(
      `select b.status::text as bin_status, r.status::text as old_reservation
       from public.bins b
       join public.reservations r on r.bin_id=b.id and r.queue_entry_id=$2
       where b.session_id=$1`,
      [sessionId, ready.queueEntryId],
    );
    expect(state.rows[0]).toEqual({
      bin_status: "RESERVED",
      old_reservation: "CANCELLED",
    });
  });

  it("rejects CHECKED_OUT cancellation without releasing the cart", async () => {
    const sessionId = await createSession(db);
    await addBins(db, sessionId, ["1"]);
    const entry = await joinQueue(db, sessionId);
    const details = await getReadyDetails(db, entry.queueEntryId);
    await checkout(db, {
      sessionId,
      pickupCode: details!.pickup_code,
      binNumber: "1",
      idempotencyKey: randomUUID(),
    });
    const result = await db.query<{ result: Record<string, unknown> }>(
      `select public.cancel_queue_entry($1,$2,$3) as result`,
      [sessionId, entry.queueEntryId, randomUUID()],
    );
    expect(result.rows[0].result.outcome).toBe("CHECKED_OUT_REJECTED");
    expect((await getEntry(db, entry.queueEntryId)).status).toBe("CHECKED_OUT");
    expect(
      await count(
        db,
        `select count(*)::int c from public.rentals where session_id=$1 and status='OUT'`,
        [sessionId],
      ),
    ).toBe(1);
  });

  it("rejects a queue entry from another session", async () => {
    const first = await createSession(db);
    const second = await createSession(db);
    const entry = await joinQueue(db, first);
    await expect(
      db.query(`select public.cancel_queue_entry($1,$2,$3)`, [
        second,
        entry.queueEntryId,
        randomUUID(),
      ]),
    ).rejects.toThrow(/ENTRY_NOT_FOUND/);
  });
});

describe("inbound command resolution and replay", () => {
  it("records TIME and its response once across event and message replays", async () => {
    const phone = "+14045550123";
    const sessionId = await createSession(db);
    await joinQueue(db, sessionId, { phone });
    const eventId = randomUUID();
    const messageId = randomUUID();
    const first = await inbound({
      from: phone,
      command: "TIME",
      providerEventId: eventId,
      providerMessageId: messageId,
    });
    expect(first).toMatchObject({ duplicate: false, outcome: "TIME_WAITING" });
    const replay = await inbound({
      from: phone,
      command: "TIME",
      providerEventId: eventId,
      providerMessageId: messageId,
    });
    expect(replay.duplicate).toBe(true);
    const messageReplay = await inbound({
      from: phone,
      command: "TIME",
      providerEventId: randomUUID(),
      providerMessageId: messageId,
    });
    expect(messageReplay.duplicate).toBe(true);
    expect(
      await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1 and type='TIME'`,
        [sessionId],
      ),
    ).toBe(1);
  });

  it.each(["STOP", "START", "HELP"] as const)(
    "acknowledges provider-managed %s without mutation or duplicate response",
    async (compliance) => {
      const phone = "+14045550124";
      const sessionId = await createSession(db);
      const entry = await joinQueue(db, sessionId, { phone });
      const before = await count(
        db,
        `select count(*)::int c from public.notification_outbox where session_id=$1`,
        [sessionId],
      );
      const result = await inbound({
        from: phone,
        command: "UNKNOWN",
        compliance,
      });
      expect(result.outcome).toBe("COMPLIANCE_ACKNOWLEDGED");
      expect((await getEntry(db, entry.queueEntryId)).status).toBe("WAITING");
      expect(
        await count(
          db,
          `select count(*)::int c from public.notification_outbox where session_id=$1`,
          [sessionId],
        ),
      ).toBe(before);
    },
  );

  it("returns safe unknown, no-match, and ambiguous responses without guessing", async () => {
    const unknown = await inbound({
      from: "+14045550991",
      command: "UNKNOWN",
    });
    expect(unknown.outcome).toBe("UNKNOWN_COMMAND");
    const noMatch = await inbound({
      from: "+14045550992",
      command: "TIME",
    });
    expect(noMatch.outcome).toBe("NO_ACTIVE_MATCH");

    const phone = "+14045550993";
    const first = await createSession(db);
    const second = await createSession(db);
    const a = await joinQueue(db, first, { phone });
    const b = await joinQueue(db, second, { phone });
    const ambiguous = await inbound({ from: phone, command: "CANCEL" });
    expect(ambiguous.outcome).toBe("AMBIGUOUS_ACTIVE_MATCH");
    expect((await getEntry(db, a.queueEntryId)).status).toBe("WAITING");
    expect((await getEntry(db, b.queueEntryId)).status).toBe("WAITING");
    const diagnostic = await db.query<{
      outcome: string;
      resolved_session_id: string | null;
    }>(
      `select outcome, resolved_session_id from public.inbound_sms_events where outcome='AMBIGUOUS_ACTIVE_MATCH'`,
    );
    expect(diagnostic.rows[0]).toEqual({
      outcome: "AMBIGUOUS_ACTIVE_MATCH",
      resolved_session_id: null,
    });
  });

  it("executes HOLD once and rejects a second HOLD after the transfer", async () => {
    const phone = "+14045550994";
    const sessionId = await createSession(db);
    await addBins(db, sessionId, ["1"]);
    const holder = await joinQueue(db, sessionId, { phone });
    const promoted = await joinQueue(db, sessionId);
    const first = await inbound({ from: phone, command: "HOLD" });
    expect(first.outcome).toBe("HOLD_CONFIRMED");
    expect((await getEntry(db, promoted.queueEntryId)).status).toBe("READY");
    expect((await getEntry(db, holder.queueEntryId)).hold_used).toBe(true);
    const second = await inbound({ from: phone, command: "HOLD" });
    expect(second.outcome).toBe("HOLD_ALREADY_USED");
  });
});

describe("outbox claim leases and retry states", () => {
  async function insertOutbox(): Promise<string> {
    const result = await db.query<{ id: string }>(
      `insert into public.notification_outbox
        (type, body, dedupe_key, destination_phone)
       values ('TIME','Panther Carts: Test. STOP=opt out.',$1,'+14045550123')
       returning id`,
      [randomUUID()],
    );
    return result.rows[0].id;
  }

  it("claims once, recovers an expired lease, and rejects a stale token", async () => {
    const id = await insertOutbox();
    const first = await db.query<{
      id: string;
      claim_token: string;
      attempts: number;
    }>(`select * from public.claim_notification_outbox('worker-a',10,120,5)`);
    expect(first.rows).toHaveLength(1);
    const second = await db.query(
      `select * from public.claim_notification_outbox('worker-b',10,120,5)`,
    );
    expect(second.rows).toHaveLength(0);

    await db.query(
      `update public.notification_outbox set lease_expires_at=now()-interval '1 second' where id=$1`,
      [id],
    );
    const recovered = await db.query<{ claim_token: string; attempts: number }>(
      `select * from public.claim_notification_outbox('worker-c',10,120,5)`,
    );
    expect(recovered.rows[0].attempts).toBe(2);
    expect(recovered.rows[0].claim_token).not.toBe(first.rows[0].claim_token);
    const stale = await db.query<{ completed: boolean }>(
      `select public.complete_notification_outbox_sent($1,$2,'message') as completed`,
      [id, first.rows[0].claim_token],
    );
    expect(stale.rows[0].completed).toBe(false);
  });

  it("backs off temporary failures, sanitizes permanent failures, and bounds attempts", async () => {
    const id = await insertOutbox();
    const claimed = await db.query<{ claim_token: string }>(
      `select * from public.claim_notification_outbox('worker-a',10,120,5)`,
    );
    await db.query(
      `select public.complete_notification_outbox_failure($1,$2,true,'temporary secret !@#',5)`,
      [id, claimed.rows[0].claim_token],
    );
    const retry = await db.query<{
      status: string;
      available_later: boolean;
      last_error: string;
    }>(
      `select status::text, available_at > now() as available_later, last_error
       from public.notification_outbox where id=$1`,
      [id],
    );
    expect(retry.rows[0]).toEqual({
      status: "PENDING",
      available_later: true,
      last_error: "temporarysecret",
    });

    await db.query(
      `update public.notification_outbox set status='PENDING', attempts=5, available_at=now() where id=$1`,
      [id],
    );
    const maxed = await db.query(
      `select * from public.claim_notification_outbox('worker-b',10,120,5)`,
    );
    expect(maxed.rows).toHaveLength(0);
    const final = await db.query<{ status: string }>(
      `select status::text from public.notification_outbox where id=$1`,
      [id],
    );
    expect(final.rows[0].status).toBe("FAILED");
  });
});
