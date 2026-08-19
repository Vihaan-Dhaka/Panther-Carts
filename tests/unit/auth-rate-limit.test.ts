import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeRateLimit,
  rateLimitIdentity,
  requestIp,
} from "@/lib/auth/rate-limit";

beforeEach(() => {
  vi.stubEnv(
    "PANTHER_AUTH_SECRET",
    "test-only-auth-secret-that-is-longer-than-thirty-two-characters",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trusted-boundary rate limiting", () => {
  it("accepts only a validated first forwarded IP", () => {
    expect(
      requestIp(
        new Headers({ "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1" }),
      ),
    ).toBe("203.0.113.7");
    expect(requestIp(new Headers({ "x-forwarded-for": "not-an-ip" }))).toBe(
      "unknown",
    );
  });

  it("stores a stable keyed identity instead of raw request data", () => {
    const identity = rateLimitIdentity("203.0.113.7", "Admin@Example.edu");
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).not.toContain("203.0.113.7");
    expect(identity).toBe(
      rateLimitIdentity("203.0.113.7", "admin@example.edu"),
    );
  });

  it("uses fixed server-owned scope limits and validates the RPC response", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, remaining: 0, retry_after_seconds: 37 },
      error: null,
    });
    await expect(
      consumeRateLimit({ rpc } as never, "staff_code_exchange", "identity"),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 37,
    });
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_scope: "staff_code_exchange",
      p_identity_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_limit: 5,
      p_window_seconds: 900,
    });
  });

  it("fails closed on a database or malformed response", async () => {
    for (const response of [
      { data: null, error: { message: "private database error" } },
      { data: { allowed: "yes" }, error: null },
    ]) {
      await expect(
        consumeRateLimit(
          { rpc: vi.fn().mockResolvedValue(response) } as never,
          "student_signup",
          "identity",
        ),
      ).rejects.toThrow(/Rate limit unavailable/);
    }
  });
});
