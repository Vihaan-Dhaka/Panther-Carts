import { describe, expect, it } from "vitest";
import { SMS_COMMANDS } from "@/lib/sms/types";

describe("project smoke test", () => {
  it("exposes exactly the three Panther Carts queue commands", () => {
    expect(SMS_COMMANDS).toEqual(["TIME", "HOLD", "CANCEL"]);
    expect(SMS_COMMANDS).not.toContain("HELP");
  });
});
