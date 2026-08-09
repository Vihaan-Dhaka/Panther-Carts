import { describe, expect, it } from "vitest";
import { QueueErrorCode, parseQueueErrorCode } from "@/lib/queue/errors";

describe("parseQueueErrorCode", () => {
  it("extracts a known token from a Postgres error message", () => {
    const message =
      "ERROR: PANTHER_CARTS:DUPLICATE_ACTIVE_ENTRY\nCONTEXT: PL/pgSQL function join_queue";
    expect(parseQueueErrorCode(message)).toBe(
      QueueErrorCode.DUPLICATE_ACTIVE_ENTRY,
    );
  });

  it("returns the token when it is the entire message", () => {
    expect(parseQueueErrorCode("PANTHER_CARTS:NOBODY_WAITING")).toBe(
      QueueErrorCode.NOBODY_WAITING,
    );
  });

  it("returns null when no domain token is present", () => {
    expect(parseQueueErrorCode("some unrelated database error")).toBeNull();
  });

  it("returns null for an unrecognized token", () => {
    expect(parseQueueErrorCode("PANTHER_CARTS:NOT_A_REAL_CODE")).toBeNull();
  });
});
