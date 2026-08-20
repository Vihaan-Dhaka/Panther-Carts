import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration, createMigratedDb, type Db } from "./pglite/harness";

const MIGRATION = "20260818120000_auth_data_protection.sql";
const PREVIOUS_MIGRATION = "20260812120000_two_way_sms.sql";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

let db: Db;

beforeEach(async () => {
  db = await createMigratedDb({ createServiceRole: true });
});

async function insertProtectedSession(status: "DRAFT" | "ACTIVE" | "CLOSED") {
  const id = randomUUID();
  await db.query(
    `insert into public.sessions (
       id, name, status, student_code, staff_code, staff_link_hash,
       staff_access_code_ciphertext, staff_access_code_hash,
       staff_credential_version, rental_duration_minutes,
       pickup_window_minutes, started_at
     ) values ($1, 'Protected', $2::public.session_status, $3, $4, $5, $6, $7,
       'hmac-v1', 60, 10,
       case when $2::text = 'ACTIVE' then now() else null end)`,
    [
      id,
      status,
      `signup-${randomUUID().replaceAll("-", "").slice(0, 32)}`,
      "v1.encrypted-link",
      HASH_A,
      "v1.encrypted-code",
      HASH_B,
    ],
  );
  return id;
}

describe("Ticket 6 authentication data migration", () => {
  it("scrubs legacy plaintext staff links while retaining a verifier", async () => {
    const legacy = await createMigratedDb({
      createServiceRole: true,
      throughMigration: PREVIOUS_MIGRATION,
    });
    const plaintext = `staff-${randomUUID().replaceAll("-", "")}`;
    await legacy.query(
      `insert into public.sessions (
         name, status, student_code, staff_code,
         rental_duration_minutes, pickup_window_minutes
       ) values ('Legacy', 'ACTIVE', $1, $2, 60, 10)`,
      [`signup-${randomUUID()}`, plaintext],
    );
    await applyMigration(legacy, MIGRATION);
    const result = await legacy.query<{
      staff_code: string;
      staff_link_hash: string;
      staff_credential_version: string;
    }>(
      `select staff_code, staff_link_hash, staff_credential_version
       from public.sessions where name = 'Legacy'`,
    );
    expect(result.rows[0].staff_code).not.toContain(plaintext);
    expect(result.rows[0].staff_code).toMatch(/^protected-legacy-/);
    expect(result.rows[0].staff_link_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[0].staff_credential_version).toBe("legacy-sha256");
  });

  it("exchanges only a valid active-session verifier and rejects expired or replayed browser tokens", async () => {
    const sessionId = await insertProtectedSession("ACTIVE");
    const first = await db.query<{
      result: { session_id: string; expires_at: string };
    }>(
      `select public.create_staff_web_session($1, $2, now() + interval '1 hour') as result`,
      [[HASH_A, HASH_C], HASH_C],
    );
    expect(first.rows[0].result.session_id).toBe(sessionId);

    await expect(
      db.query(
        `select public.create_staff_web_session($1, $2, now() + interval '1 hour')`,
        [[HASH_A], HASH_C],
      ),
    ).rejects.toThrow(/staff_web_sessions_token_hash_key/);
    await expect(
      db.query(
        `select public.create_staff_web_session($1, $2, now() + interval '1 hour')`,
        [["d".repeat(64)], "e".repeat(64)],
      ),
    ).rejects.toThrow(/INVALID_STAFF_CREDENTIAL/);
    await expect(
      db.query(
        `select public.create_staff_web_session($1, $2, now() - interval '1 second')`,
        [[HASH_A], "f".repeat(64)],
      ),
    ).rejects.toThrow(/INVALID_STAFF_CREDENTIAL/);

    await db.query(`select public.admin_end_session($1)`, [sessionId]);
    const revoked = await db.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked
       from public.staff_web_sessions where token_hash = $1`,
      [HASH_C],
    );
    expect(revoked.rows[0].revoked).toBe(true);
    await expect(
      db.query(
        `select public.create_staff_web_session($1, $2, now() + interval '1 hour')`,
        [[HASH_A], "f".repeat(64)],
      ),
    ).rejects.toThrow(/SESSION_NOT_ACTIVE/);
  });

  it("bounded-cleanups expired and revoked staff browser sessions during exchange", async () => {
    const sessionId = await insertProtectedSession("ACTIVE");
    await db.query(
      `insert into public.staff_web_sessions (
         session_id, token_hash, created_at, expires_at, revoked_at
       ) values
         ($1, $2, now() - interval '2 hours', now() - interval '1 hour', null),
         ($1, $3, now() - interval '1 hour', now() + interval '1 hour', now())`,
      [sessionId, "d".repeat(64), "e".repeat(64)],
    );

    await db.query(
      `select public.create_staff_web_session(
         $1, $2, now() + interval '1 hour'
       )`,
      [[HASH_A], "f".repeat(64)],
    );
    const stale = await db.query<{ count: number }>(
      `select count(*)::int as count
       from public.staff_web_sessions
       where expires_at <= now() or revoked_at is not null`,
    );
    expect(stale.rows[0].count).toBe(0);
  });

  it("enforces exact fixed-window rate-limit boundaries and resets after expiry", async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await db.query<{
        value: { allowed: boolean; remaining: number };
      }>(`select public.consume_rate_limit('test_scope', $1, 3, 60) as value`, [
        HASH_A,
      ]);
      expect(result.rows[0].value.allowed).toBe(attempt <= 3);
      expect(result.rows[0].value.remaining).toBe(Math.max(0, 3 - attempt));
    }
    await db.query(
      `update public.rate_limit_buckets
       set window_started_at = now() - interval '2 minutes',
           expires_at = now() - interval '1 minute'
       where scope = 'test_scope' and identity_hash = $1`,
      [HASH_A],
    );
    const reset = await db.query<{
      value: { allowed: boolean; remaining: number };
    }>(`select public.consume_rate_limit('test_scope', $1, 3, 60) as value`, [
      HASH_A,
    ]);
    expect(reset.rows[0].value).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("denies anon and authenticated table/view/RPC access while service_role retains trusted access", async () => {
    const sessionId = await insertProtectedSession("ACTIVE");
    await db.query(
      `insert into public.students
       (session_id, full_name, panther_id, email, phone)
       values ($1, 'Private Student', '900000001', 'private@example.edu', '+14045550123')`,
      [sessionId],
    );

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query(`select * from public.students`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query(`select * from public.v_current_waitlist`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query(`select public.consume_rate_limit('test_scope', $1, 3, 60)`, [
          HASH_A,
        ]),
      ).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }

    await db.exec("set role service_role");
    const serviceRead = await db.query<{ full_name: string }>(
      `select full_name from public.students`,
    );
    expect(serviceRead.rows).toEqual([{ full_name: "Private Student" }]);
    const serviceRate = await db.query<{ value: { allowed: boolean } }>(
      `select public.consume_rate_limit('test_scope', $1, 3, 60) as value`,
      [HASH_A],
    );
    expect(serviceRate.rows[0].value.allowed).toBe(true);
    await db.exec("reset role");
  });

  it("forces RLS and installs an explicit restrictive policy on every PII-bearing table", async () => {
    const rows = await db.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_count: number;
    }>(
      `select c.relname as table_name,
              c.relrowsecurity as rls_enabled,
              c.relforcerowsecurity as rls_forced,
              count(p.polname)::int as policy_count
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_policy p on p.polrelid = c.oid
       where n.nspname = 'public'
         and c.relname in (
           'sessions', 'students', 'bins', 'queue_entries', 'reservations', 'rentals',
           'notification_outbox', 'audit_events', 'inbound_sms_events',
           'staff_web_sessions', 'rate_limit_buckets'
         )
       group by c.relname, c.relrowsecurity, c.relforcerowsecurity
       order by c.relname`,
    );
    expect(rows.rows).toHaveLength(11);
    expect(
      rows.rows.every(
        (row) => row.rls_enabled && row.rls_forced && row.policy_count >= 1,
      ),
    ).toBe(true);

    const realtimeTables = await db.query<{ tablename: string }>(
      `select tablename
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename in (
           'sessions', 'students', 'bins', 'queue_entries', 'reservations', 'rentals',
           'notification_outbox', 'audit_events', 'inbound_sms_events',
           'staff_web_sessions', 'rate_limit_buckets'
         )`,
    );
    expect(realtimeTables.rows).toEqual([]);
  });
});
