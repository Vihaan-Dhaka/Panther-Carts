import { describe, expect, it } from "vitest";
import { joinQueueSchema } from "@/lib/validation/student";

const valid = {
  fullName: "Jordan Panther",
  pantherId: "900123456",
  email: "Jordan.Panther@Example.EDU",
  phone: "(404) 555-0123",
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
});
