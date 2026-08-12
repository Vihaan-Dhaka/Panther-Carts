import { describe, expect, it } from "vitest";
import { parseSmsCommand } from "@/lib/sms/commands";

describe("SMS command parsing", () => {
  it.each([
    [" time ", "TIME"],
    ["Hold", "HOLD"],
    ["cancel\r\n", "CANCEL"],
  ])("normalizes %j", (body, command) => {
    expect(parseSmsCommand(body)).toEqual({ kind: "command", command });
  });

  it.each([
    ["STOP", "STOP"],
    ["start", "START"],
    [" UNSTOP ", "START"],
    ["HELP", "HELP"],
  ])(
    "keeps compliance keyword %s out of the dispatcher",
    (body, classification) => {
      expect(parseSmsCommand(body)).toEqual({
        kind: "compliance",
        classification,
      });
    },
  );

  it("returns unknown without advertising HELP as an application command", () => {
    expect(parseSmsCommand("where am I")).toEqual({ kind: "unknown" });
  });
});
