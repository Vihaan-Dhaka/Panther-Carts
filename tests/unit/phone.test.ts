import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/validation/phone";

describe("normalizePhone", () => {
  it("prefixes a bare 10-digit US number with +1", () => {
    expect(normalizePhone("(404) 555-0123")).toBe("+14045550123");
    expect(normalizePhone("404-555-0123")).toBe("+14045550123");
    expect(normalizePhone("404.555.0123")).toBe("+14045550123");
  });

  it("normalizes an 11-digit number that already leads with 1", () => {
    expect(normalizePhone("1 (404) 555-0123")).toBe("+14045550123");
    expect(normalizePhone("+1 404 555 0123")).toBe("+14045550123");
  });

  it("is idempotent on an already-normalized value", () => {
    expect(normalizePhone("+14045550123")).toBe("+14045550123");
  });

  it("returns an empty string for empty or nullish input", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
  });

  it("preserves other digit counts with a leading plus (fallback)", () => {
    expect(normalizePhone("5550123")).toBe("+5550123");
  });
});
