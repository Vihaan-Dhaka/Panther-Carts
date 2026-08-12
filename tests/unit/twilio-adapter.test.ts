import { describe, expect, it, vi } from "vitest";
import { SmsWebhookError } from "@/lib/sms/errors";
import { computeTwilioSignature, TwilioSmsProvider } from "@/lib/sms/twilio";

const accountSid = `AC${"a".repeat(32)}`;
const serviceSid = `MG${"b".repeat(32)}`;
const messageSid = `SM${"c".repeat(32)}`;
const webhookUrl = "https://example.com/api/sms/twilio?source=console";
const authToken = "auth-token";

function provider(
  fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch,
  requestTimeoutMs?: number,
) {
  return new TwilioSmsProvider(
    {
      accountSid,
      authToken,
      messagingServiceSid: serviceSid,
      fromNumber: "+14045550100",
      webhookUrl,
    },
    {
      fetch: fetchImpl,
      now: () => new Date("2026-08-11T20:00:00Z"),
      requestTimeoutMs,
    },
  );
}

function inboundRequest(
  overrides: Record<string, string> = {},
  exactUrl = webhookUrl,
) {
  const parameters = {
    MessageSid: messageSid,
    From: "+14045550123",
    To: "+14045550100",
    Body: "cancel",
    ...overrides,
  };
  const body = new URLSearchParams(parameters).toString();
  const signature = computeTwilioSignature(authToken, exactUrl, parameters);
  return new Request("https://internal.invalid/api/sms/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
  });
}

describe("Twilio adapter", () => {
  it("aborts a provider request at the configured deadline", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    ) as unknown as typeof fetch;

    await expect(
      provider(fetchImpl, 5).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  });

  it("canonicalizes repeated parameters like Twilio's reference validator", () => {
    expect(
      computeTwilioSignature(authToken, webhookUrl, {
        Alpha: ["b", "a", "a"],
      }),
    ).toBe(
      computeTwilioSignature(authToken, webhookUrl, {
        Alpha: ["a", "b"],
      }),
    );
  });

  it("sends form-encoded SMS through the fixed sender and Messaging Service", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ sid: messageSid }));
    await expect(
      provider(fetchImpl).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).resolves.toEqual({ providerMessageId: messageSid });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    );
    expect(new URLSearchParams(String(init.body))).toEqual(
      new URLSearchParams({
        To: "+14045550123",
        From: "+14045550100",
        MessagingServiceSid: serviceSid,
        Body: "Panther Carts: Test",
      }),
    );
  });

  it("maps opt-out as permanent and rate limiting as retryable", async () => {
    const optedOut = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 21610 }, { status: 400 }));
    await expect(
      provider(optedOut).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).rejects.toMatchObject({ code: "RECIPIENT_OPTED_OUT", retryable: false });
    const limited = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 20429 }, { status: 429 }));
    await expect(
      provider(limited).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("verifies against the configured exact URL and all form parameters", async () => {
    await expect(
      provider().parseInboundWebhook(inboundRequest({ OptOutType: "STOP" })),
    ).resolves.toMatchObject({
      providerEventId: messageSid,
      providerMessageId: messageSid,
      compliance: "STOP",
    });
  });

  it("treats an empty OptOutType as an absent classification", async () => {
    await expect(
      provider().parseInboundWebhook(inboundRequest({ OptOutType: "" })),
    ).resolves.toMatchObject({
      body: "cancel",
      compliance: null,
    });
  });

  it.each(["missing", "altered-parameter", "wrong-url"])(
    "rejects %s signatures",
    async (scenario) => {
      let request = inboundRequest();
      if (scenario === "missing") {
        const body = await request.text();
        request = new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      } else if (scenario === "altered-parameter") {
        request = inboundRequest({ Body: "TIME" });
        const body = (await request.text()).replace("TIME", "HOLD");
        request = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        });
      } else {
        request = inboundRequest({}, "https://wrong.example/webhook");
      }
      await expect(
        provider().parseInboundWebhook(request),
      ).rejects.toBeInstanceOf(SmsWebhookError);
    },
  );
});
