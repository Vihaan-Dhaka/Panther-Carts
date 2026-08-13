import { describe, expect, it, vi } from "vitest";
import type { StudentSignupDatabaseClient } from "@/lib/queue/join-queue";
import {
  executeStudentSignup,
  getStudentSignupAvailability,
} from "@/lib/queue/student-signup";

const SESSION_ID = "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9";
const validInput = {
  fullName: "  Jordan Panther  ",
  pantherId: "  900123456  ",
  email: "  Jordan.Panther@Example.EDU  ",
  phone: "(404) 555-0123",
  smsConsent: "on",
};

type FakeOptions = {
  session?: { id: string; status: "DRAFT" | "ACTIVE" | "CLOSED" } | null;
  sessionError?: { message: string } | null;
  rpcData?: unknown;
  rpcError?: { message: string } | null;
};

function fakeClient(options: FakeOptions = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data:
      options.session === undefined
        ? { id: SESSION_ID, status: "ACTIVE" }
        : options.session,
    error: options.sessionError ?? null,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn().mockResolvedValue({
    data: options.rpcData ?? {
      queue_entry: { status: "READY", pickup_code: "0427" },
      position: 0,
      estimated_wait_minutes: 0,
    },
    error: options.rpcError ?? null,
  });

  return {
    client: { from, rpc } as unknown as StudentSignupDatabaseClient,
    from,
    rpc,
  };
}

describe("student signup server operation", () => {
  it("normalizes valid form values and returns a READY pickup code", async () => {
    const { client, rpc } = fakeClient();
    const state = await executeStudentSignup(client, "fall-2026", validInput);

    expect(state).toEqual({
      status: "success",
      result: { status: "READY", pickupCode: "0427" },
    });
    expect(rpc).toHaveBeenCalledWith("join_queue", {
      p_session_id: SESSION_ID,
      p_full_name: "Jordan Panther",
      p_panther_id: "900123456",
      p_email: "jordan.panther@example.edu",
      p_phone: "+14045550123",
      p_sms_consent: true,
    });
  });

  it("returns field errors and preserves values without touching the database", async () => {
    const { client, from, rpc } = fakeClient();
    const state = await executeStudentSignup(client, "fall-2026", {
      ...validInput,
      email: "not-an-email",
    });

    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.fieldErrors.email?.[0]).toBe("A valid email is required");
      expect(state.values.email).toBe("not-an-email");
    }
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires SMS consent without touching the database", async () => {
    const { client, from, rpc } = fakeClient();
    const state = await executeStudentSignup(client, "fall-2026", {
      ...validInput,
      smsConsent: null,
    });

    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.fieldErrors.smsConsent?.[0]).toContain("transactional SMS");
      expect(state.values.smsConsent).toBe(false);
    }
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [null, "invalid"],
    [{ id: SESSION_ID, status: "DRAFT" as const }, "not active"],
    [{ id: SESSION_ID, status: "CLOSED" as const }, "not active"],
  ])(
    "rejects unknown or inactive sessions safely",
    async (session, message) => {
      const { client, rpc } = fakeClient({ session });
      const state = await executeStudentSignup(client, "fall-2026", validInput);

      expect(state.status).toBe("error");
      if (state.status === "error") {
        expect(state.formError).toContain(message);
        expect(state.formError).not.toContain(SESSION_ID);
      }
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("maps a duplicate active signup to a safe phone error", async () => {
    const { client } = fakeClient({
      rpcError: {
        message:
          "ERROR: PANTHER_CARTS:DUPLICATE_ACTIVE_ENTRY raw internal context",
      },
    });
    const state = await executeStudentSignup(client, "fall-2026", validInput);

    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.fieldErrors.phone?.[0]).toContain("active signup");
      expect(JSON.stringify(state)).not.toContain("raw internal context");
    }
  });

  it.each([
    ["INVALID_STUDENT_INPUT", "review your information"],
    ["INVALID_EMAIL", "student email"],
    ["INVALID_PHONE", "valid phone"],
    ["SESSION_NOT_FOUND", "invalid"],
    ["SESSION_NOT_ACTIVE", "not active"],
  ])(
    "maps PANTHER_CARTS:%s without exposing database text",
    async (code, message) => {
      const { client } = fakeClient({
        rpcError: { message: `PANTHER_CARTS:${code} secret SQL detail` },
      });
      const state = await executeStudentSignup(client, "fall-2026", validInput);
      const serialized = JSON.stringify(state);

      expect(state.status).toBe("error");
      expect(serialized).toContain(message);
      expect(serialized).not.toContain("secret SQL detail");
    },
  );

  it("maps unknown database failures to a safe unexpected error", async () => {
    const { client } = fakeClient({
      rpcError: { message: "duplicate key students_phone_idx private detail" },
    });
    const state = await executeStudentSignup(client, "fall-2026", validInput);

    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).toContain("try again");
    expect(JSON.stringify(state)).not.toContain("private detail");
  });

  it.each([
    [18, { status: "WAITING", position: 3, estimatedWaitMinutes: 18 }],
    [null, { status: "WAITING", position: 3, estimatedWaitMinutes: null }],
  ])(
    "returns a WAITING result with estimate %s",
    async (estimate, expected) => {
      const { client } = fakeClient({
        rpcData: {
          queue_entry: { status: "WAITING", pickup_code: null },
          position: 3,
          estimated_wait_minutes: estimate,
        },
      });

      await expect(
        executeStudentSignup(client, "fall-2026", validInput),
      ).resolves.toEqual({ status: "success", result: expected });
    },
  );

  it("rejects a malformed READY response without exposing it", async () => {
    const { client } = fakeClient({
      rpcData: {
        queue_entry: { status: "READY", pickup_code: "123" },
        position: 0,
        estimated_wait_minutes: 0,
      },
    });
    const state = await executeStudentSignup(client, "fall-2026", validInput);

    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).toContain("try again");
    expect(JSON.stringify(state)).not.toContain("pickupCode");
    expect(JSON.stringify(state)).not.toContain("queue_entry");
  });
});

describe("student signup page availability", () => {
  it("accepts an active session and returns only the public code", async () => {
    const { client } = fakeClient();
    await expect(
      getStudentSignupAvailability(client, "  fall-2026  "),
    ).resolves.toEqual({ available: true, sessionCode: "fall-2026" });
  });

  it("returns a safe message when session lookup fails", async () => {
    const { client } = fakeClient({
      sessionError: { message: "connection details and SQL" },
    });
    const availability = await getStudentSignupAvailability(
      client,
      "fall-2026",
    );

    expect(availability.available).toBe(false);
    expect(JSON.stringify(availability)).not.toContain("SQL");
  });
});
