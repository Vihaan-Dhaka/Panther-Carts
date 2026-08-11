import { describe, expect, it } from "vitest";
import {
  binNumberSchema,
  checkoutConfirmationSchema,
  checkoutRpcResponseSchema,
  pickupCodeSchema,
  returnRpcResponseSchema,
  staffSessionRowSchema,
} from "@/lib/validation/staff";

const STUDENT_ID = "d7ce3cb5-dbf2-4caf-a9f2-1d76d676caa4";

describe("staff station validation", () => {
  it.each(["0000", "0427", "9999"])(
    "accepts the exact four-digit pickup code %s",
    (code) => {
      expect(pickupCodeSchema.parse(code)).toBe(code);
    },
  );

  it.each(["", "123", "12345", "12a4", 427, null])(
    "rejects malformed pickup code %j",
    (code) => {
      expect(pickupCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  it("trims a physical bin number and rejects missing or oversized values", () => {
    expect(binNumberSchema.parse("  014  ")).toBe("014");
    expect(binNumberSchema.safeParse("   ").success).toBe(false);
    expect(binNumberSchema.safeParse("x".repeat(201)).success).toBe(false);
  });

  it("requires a checked PantherCard confirmation and a UUID idempotency key", () => {
    const key = "81bbf354-a557-4d22-9da0-6574416c62f1";
    expect(
      checkoutConfirmationSchema.parse({
        binNumber: "7",
        pantherCardCollected: "on",
        idempotencyKey: key,
      }),
    ).toEqual({
      binNumber: "7",
      pantherCardCollected: true,
      idempotencyKey: key,
    });
    expect(
      checkoutConfirmationSchema.safeParse({
        binNumber: "7",
        pantherCardCollected: null,
        idempotencyKey: key,
      }).success,
    ).toBe(false);
    expect(
      checkoutConfirmationSchema.safeParse({
        binNumber: "7",
        pantherCardCollected: "on",
        idempotencyKey: "student-900123456",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed session lookup rows", () => {
    expect(
      staffSessionRowSchema.safeParse({ id: "internal-id", status: "ACTIVE" })
        .success,
    ).toBe(false);
    expect(
      staffSessionRowSchema.safeParse({
        id: "81bbf354-a557-4d22-9da0-6574416c62f1",
        status: "UNKNOWN",
      }).success,
    ).toBe(false);
  });

  it("validates the safe subset of checkout and return RPC responses", () => {
    expect(
      checkoutRpcResponseSchema.safeParse({
        rental: {
          session_id: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9",
          bin_id: "a83ee1cf-bd03-4d54-9272-bab9459c92db",
          student_id: STUDENT_ID,
          status: "OUT",
          due_at: "2026-08-11T19:30:00+00:00",
          panthercard_collected_at: "2026-08-11T18:30:00+00:00",
          checkout_idempotency_key: "7b830507-034f-4746-9a67-f7e9184d40bc",
        },
        swapped: false,
        idempotent_replay: true,
      }).success,
    ).toBe(true);
    expect(
      checkoutRpcResponseSchema.safeParse({
        rental: { student_id: STUDENT_ID, status: "RETURNED" },
        swapped: "no",
        idempotent_replay: false,
      }).success,
    ).toBe(false);

    expect(
      returnRpcResponseSchema.safeParse({
        rental: {
          session_id: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9",
          bin_id: "a83ee1cf-bd03-4d54-9272-bab9459c92db",
          student_id: STUDENT_ID,
          status: "RETURNED",
          was_late: false,
          panthercard_returned_at: "2026-08-11T19:00:00+00:00",
          return_idempotency_key: "7b830507-034f-4746-9a67-f7e9184d40bc",
        },
        reservation: null,
        idempotent_replay: false,
      }).success,
    ).toBe(true);
    expect(
      returnRpcResponseSchema.safeParse({
        rental: {
          student_id: "raw-id",
          status: "RETURNED",
          was_late: false,
          panthercard_returned_at: "not-a-date",
        },
        reservation: null,
        idempotent_replay: false,
      }).success,
    ).toBe(false);
  });
});
