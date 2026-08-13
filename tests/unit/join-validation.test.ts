import { describe, expect, it } from "vitest";
import {
  joinQueueRpcResponseSchema,
  joinQueueSchema,
  studentSessionCodeSchema,
} from "@/lib/validation/student";

const valid = {
  fullName: "Jordan Panther",
  pantherId: "900123456",
  email: "Jordan.Panther@Example.EDU",
  phone: "(404) 555-0123",
  smsConsent: "on",
};

describe("joinQueueSchema", () => {
  it("accepts valid input and normalizes email and phone", () => {
    const result = joinQueueSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("jordan.panther@example.edu");
      expect(result.data.phone).toBe("+14045550123");
      expect(result.data.fullName).toBe("Jordan Panther");
    }
  });

  it("rejects a missing full name", () => {
    const result = joinQueueSchema.safeParse({ ...valid, fullName: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = joinQueueSchema.safeParse({
      ...valid,
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a phone number that cannot be normalized to E.164", () => {
    const result = joinQueueSchema.safeParse({ ...valid, phone: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string form fields safely", () => {
    const result = joinQueueSchema.safeParse({
      ...valid,
      fullName: new Blob(["Jordan Panther"]),
    });
    expect(result.success).toBe(false);
  });

  it("requires explicit transactional SMS consent", () => {
    expect(
      joinQueueSchema.safeParse({ ...valid, smsConsent: null }).success,
    ).toBe(false);
  });
});

describe("studentSessionCodeSchema", () => {
  it("trims a valid code and rejects missing or oversized codes", () => {
    expect(studentSessionCodeSchema.parse("  fall-session  ")).toBe(
      "fall-session",
    );
    expect(studentSessionCodeSchema.safeParse("").success).toBe(false);
    expect(studentSessionCodeSchema.safeParse("x".repeat(201)).success).toBe(
      false,
    );
  });
});

describe("joinQueueRpcResponseSchema", () => {
  it("requires a four-digit PostgreSQL pickup code for READY", () => {
    expect(
      joinQueueRpcResponseSchema.safeParse({
        queue_entry: { status: "READY", pickup_code: "0427" },
        position: 0,
        estimated_wait_minutes: 0,
      }).success,
    ).toBe(true);
    expect(
      joinQueueRpcResponseSchema.safeParse({
        queue_entry: { status: "READY", pickup_code: "427" },
        position: 0,
        estimated_wait_minutes: 0,
      }).success,
    ).toBe(false);
  });

  it("requires a positive position for WAITING", () => {
    expect(
      joinQueueRpcResponseSchema.safeParse({
        queue_entry: { status: "WAITING", pickup_code: null },
        position: 0,
        estimated_wait_minutes: null,
      }).success,
    ).toBe(false);
  });
});
