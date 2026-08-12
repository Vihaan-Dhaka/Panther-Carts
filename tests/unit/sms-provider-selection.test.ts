import { describe, expect, it } from "vitest";
import { createSmsProvider } from "@/lib/sms/provider";

const accountSid = `AC${"a".repeat(32)}`;
const serviceSid = `MG${"b".repeat(32)}`;

describe("SMS provider selection", () => {
  it("validates only Telnyx credentials when Telnyx is selected", () => {
    const provider = createSmsProvider({
      SMS_PROVIDER: "telnyx",
      SMS_FROM_NUMBER: "+14045550100",
      TELNYX_API_KEY: "key",
      TELNYX_PUBLIC_KEY: Buffer.alloc(32, 1).toString("base64"),
      TWILIO_ACCOUNT_SID: "intentionally-invalid-and-unused",
    });
    expect(provider.name).toBe("telnyx");
  });

  it("validates only Twilio credentials when Twilio is selected", () => {
    const provider = createSmsProvider({
      SMS_PROVIDER: "twilio",
      SMS_FROM_NUMBER: "+14045550100",
      TWILIO_ACCOUNT_SID: accountSid,
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_MESSAGING_SERVICE_SID: serviceSid,
      TWILIO_WEBHOOK_URL: "https://example.com/api/sms/twilio",
      TELNYX_API_KEY: "",
    });
    expect(provider.name).toBe("twilio");
  });

  it.each([undefined, "", "other"])("rejects provider %j", (selected) => {
    expect(() => createSmsProvider({ SMS_PROVIDER: selected })).toThrow(
      /SMS_PROVIDER/,
    );
  });
});
