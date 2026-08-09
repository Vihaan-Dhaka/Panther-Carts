import { describe, expect, it } from "vitest";
import { SMS_COMMANDS } from "@/lib/sms/types";

describe("project smoke test", () => {
  it("exposes the four SMS commands from the spec", () => {
    expect(SMS_COMMANDS).toEqual(["TIME", "HOLD", "CANCEL", "HELP"]);
  });
});
