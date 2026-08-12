import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SmsWebhookError } from "@/lib/sms/errors";
import { TelnyxSmsProvider } from "@/lib/sms/telnyx";

const NOW = new Date("2026-08-11T20:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = (publicKey as KeyObject)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");

function provider(
  fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch,
  requestTimeoutMs?: number,
) {
  return new TelnyxSmsProvider(
    {
      apiKey: "secret-key",
      publicKey: rawPublicKey,
      fromNumber: "+14045550100",
    },
    { fetch: fetchImpl, now: () => NOW, requestTimeoutMs },
  );
}

function webhook(bodyOverride: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    data: {
      event_type: "message.received",
      id: "event-1",
      occurred_at: NOW.toISOString(),
      payload: {
        id: "message-1",
        from: { phone_number: "+14045550123" },
        to: [{ phone_number: "+14045550100" }],
        text: " time ",
        received_at: NOW.toISOString(),
        ...bodyOverride,
      },
    },
  });

  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const signature = sign(
    null,
    Buffer.from(`${timestamp}|${body}`),
    privateKey,
  ).toString("base64");
  return { body, timestamp, signature };
}

describe("Telnyx adapter", () => {
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

  it("sends API v2 GSM-7 SMS with E.164 addresses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { id: "provider-message-id" } }),
      );
    await expect(
      provider(fetchImpl).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).resolves.toEqual({ providerMessageId: "provider-message-id" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          from: "+14045550100",
          to: "+14045550123",
          text: "Panther Carts: Test",
          type: "SMS",
          encoding: "gsm7",
        }),
      }),
    );
  });

  it("maps opt-out permanently and server failures as retryable", async () => {
    const optedOut = vi
      .fn()
      .mockResolvedValue(
        Response.json({ errors: [{ code: "40300" }] }, { status: 403 }),
      );
    await expect(
      provider(optedOut).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).rejects.toMatchObject({
      code: "RECIPIENT_OPTED_OUT",
      retryable: false,
    });
    const unavailable = vi
      .fn()
      .mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(
      provider(unavailable).send({
        from: "+14045550100",
        to: "+14045550123",
        body: "Panther Carts: Test",
      }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("accepts a valid exact-body signature and parses provider identifiers", async () => {
    const signed = webhook({ autoresponse_type: "HELP" });
    const request = new Request("https://example.com/api/sms/telnyx", {
      method: "POST",
      headers: {
        "telnyx-signature-ed25519": signed.signature,
        "telnyx-timestamp": signed.timestamp,
      },
      body: signed.body,
    });
    await expect(
      provider().parseInboundWebhook(request),
    ).resolves.toMatchObject({
      providerEventId: "event-1",
      providerMessageId: "message-1",
      from: "+14045550123",
      to: "+14045550100",
      compliance: "HELP",
    });
  });

  it.each(["missing", "invalid", "stale", "altered"])(
    "rejects %s signatures before parsing",
    async (scenario) => {
      const signed = webhook();
      const headers: Record<string, string> = {
        "telnyx-signature-ed25519": signed.signature,
        "telnyx-timestamp": signed.timestamp,
      };
      let body = signed.body;
      if (scenario === "missing") delete headers["telnyx-signature-ed25519"];
      if (scenario === "invalid") headers["telnyx-signature-ed25519"] = "bad";
      if (scenario === "stale") headers["telnyx-timestamp"] = "1";
      if (scenario === "altered") body += " ";
      const request = new Request("https://example.com/api/sms/telnyx", {
        method: "POST",
        headers,
        body,
      });
      await expect(
        provider().parseInboundWebhook(request),
      ).rejects.toBeInstanceOf(SmsWebhookError);
    },
  );
});
