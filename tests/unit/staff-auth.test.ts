import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeStaffCredential,
  resolveStaffSession,
  STAFF_SESSION_SECONDS,
  staffSessionCookieOptions,
} from "@/lib/auth/staff";

const SESSION_ID = "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9";
const OTHER_SESSION_ID = "15f7d61c-a959-447c-bb3f-da59561b90a2";
const FUTURE = new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  vi.stubEnv(
    "PANTHER_AUTH_SECRET",
    "test-only-auth-secret-that-is-longer-than-thirty-two-characters",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function query(response: { data: unknown; error: unknown }) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(response);
  return builder;
}

function resolveClient(options?: { webSession?: unknown; session?: unknown }) {
  const builders = {
    staff_web_sessions: query({
      data:
        options && "webSession" in options
          ? options.webSession
          : { session_id: SESSION_ID, expires_at: FUTURE, revoked_at: null },
      error: null,
    }),
    sessions: query({
      data:
        options && "session" in options
          ? options.session
          : { id: SESSION_ID, status: "ACTIVE" },
      error: null,
    }),
  };
  return {
    client: { from: vi.fn((table: keyof typeof builders) => builders[table]) },
    builders,
  };
}

describe("staff credential exchange and browser sessions", () => {
  it("uses a hardened cookie that survives a cross-site top-level link navigation", () => {
    expect(staffSessionCookieOptions).toEqual({
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/staff",
      maxAge: STAFF_SESSION_SECONDS,
      priority: "high",
    });
    expect(STAFF_SESSION_SECONDS).toBe(12 * 60 * 60);
  });

  it("exchanges a valid link using only verifiers and returns a fresh browser token", async () => {
    const rpc = vi.fn().mockImplementation(async (_name, args) => ({
      data: {
        session_id: SESSION_ID,
        expires_at: args.p_expires_at,
      },
      error: null,
    }));
    const rawLink = "A".repeat(43);
    const result = await exchangeStaffCredential(
      { rpc } as never,
      "link",
      rawLink,
    );
    expect(result).toMatchObject({ sessionId: SESSION_ID });
    expect(result?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const serialized = JSON.stringify(rpc.mock.calls);
    expect(serialized).not.toContain(rawLink);
    expect(serialized).not.toContain(result?.token);
    expect(rpc.mock.calls[0][1].p_candidate_hashes).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it("rejects malformed credentials before database access", async () => {
    const rpc = vi.fn();
    await expect(
      exchangeStaffCredential({ rpc } as never, "code", "1234"),
    ).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects expired, revoked, and cross-session browser sessions without exposing PII", async () => {
    const token = "B".repeat(43);
    for (const webSession of [
      {
        session_id: SESSION_ID,
        expires_at: new Date(0).toISOString(),
        revoked_at: null,
      },
      {
        session_id: SESSION_ID,
        expires_at: FUTURE,
        revoked_at: new Date().toISOString(),
      },
    ]) {
      const { client, builders } = resolveClient({ webSession });
      await expect(
        resolveStaffSession(client as never, token),
      ).resolves.toBeNull();
      expect(builders.sessions.select).not.toHaveBeenCalled();
    }

    const crossSession = resolveClient({
      session: { id: OTHER_SESSION_ID, status: "ACTIVE" },
    });
    await expect(
      resolveStaffSession(crossSession.client as never, token),
    ).rejects.toThrow(/authorization unavailable/);
  });

  it("returns only the authoritative session id and keyed token identity", async () => {
    const { client, builders } = resolveClient();
    const authorization = await resolveStaffSession(
      client as never,
      "C".repeat(43),
    );
    expect(authorization).toEqual({
      sessionId: SESSION_ID,
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(builders.sessions.eq.mock.calls).toContainEqual(["id", SESSION_ID]);
    expect(JSON.stringify(authorization)).not.toMatch(
      /full_name|panther_id|phone/,
    );
  });
});
