import { describe, expect, it } from "vitest";
import { analyzeSmsSegments } from "@/lib/sms/gsm";
import {
  AMBIGUOUS_ENTRY_MESSAGE,
  CHECKED_OUT_CANCEL_MESSAGE,
  NO_ACTIVE_ENTRY_MESSAGE,
  UNKNOWN_COMMAND_MESSAGE,
  holdConfirmationMessage,
  readyMessage,
  signupWaitingMessage,
  timeReadyMessage,
  timeRentalMessage,
  timeWaitingMessage,
} from "@/lib/sms/messages";

describe("GSM-7 analyzer", () => {
  it("counts extension-table characters as two septets", () => {
    expect(analyzeSmsSegments("A^{}\\[~]|EUR \u20ac")).toEqual({
      encoding: "GSM-7",
      units: 23,
      segments: 1,
    });
  });

  it("detects UCS-2 and uses UTF-16 units", () => {
    expect(analyzeSmsSegments("cart \ud83d\uded2")).toEqual({
      encoding: "UCS-2",
      units: 7,
      segments: 1,
    });
    expect(analyzeSmsSegments("\u201cUnicode quote\u201d").encoding).toBe(
      "UCS-2",
    );
  });

  it("uses concatenated-message capacities after the first segment", () => {
    expect(analyzeSmsSegments("a".repeat(161)).segments).toBe(2);
    expect(analyzeSmsSegments("\u2603".repeat(71)).segments).toBe(2);
  });
});

describe("normal Panther Carts templates", () => {
  it("keeps every boundary-value template in one GSM-7 segment", () => {
    const messages = [
      signupWaitingMessage(999999, 999999),
      signupWaitingMessage(999999, null),
      readyMessage("9999", 240),
      holdConfirmationMessage(999999),
      timeWaitingMessage(999999, 999999),
      timeWaitingMessage(999999, null),
      timeReadyMessage("9999", 240),
      timeRentalMessage("999999", 1440),
      timeRentalMessage("999999", -999999),
      UNKNOWN_COMMAND_MESSAGE,
      NO_ACTIVE_ENTRY_MESSAGE,
      AMBIGUOUS_ENTRY_MESSAGE,
      CHECKED_OUT_CANCEL_MESSAGE,
    ];
    for (const message of messages) {
      expect(analyzeSmsSegments(message), message).toMatchObject({
        encoding: "GSM-7",
        segments: 1,
      });
    }
  });
});
