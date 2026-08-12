import "server-only";

import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { SmsProviderError, SmsWebhookError } from "./errors";
import type { InboundSms, OutboundSms, SmsProvider } from "./types";
import {
  outboundSmsSchema,
  telnyxErrorResponseSchema,
  telnyxSendResponseSchema,
  telnyxWebhookSchema,
} from "@/lib/validation/sms";

const TELNYX_MESSAGES_URL = "https://api.telnyx.com/v2/messages";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type TelnyxConfig = {
  apiKey: string;
  publicKey: string;
  fromNumber: string;
};

type TelnyxDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
};

function telnyxPublicKey(value: string): KeyObject {
  if (value.includes("BEGIN PUBLIC KEY")) return createPublicKey(value);
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 32) throw new SmsWebhookError("INVALID_SIGNATURE");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function verifyTelnyxWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  now: Date;
}): void {
  if (!input.signature || !input.timestamp || !/^\d+$/.test(input.timestamp)) {
    throw new SmsWebhookError("INVALID_SIGNATURE");
  }
  const signedAt = Number(input.timestamp);
  if (
    !Number.isSafeInteger(signedAt) ||
    Math.abs(Math.floor(input.now.getTime() / 1_000) - signedAt) >
      WEBHOOK_TOLERANCE_SECONDS
  ) {
    throw new SmsWebhookError("INVALID_SIGNATURE");
  }

  let signature: Buffer;
  let publicKey: KeyObject;
  try {
    signature = Buffer.from(input.signature, "base64");
    publicKey = telnyxPublicKey(input.publicKey);
  } catch {
    throw new SmsWebhookError("INVALID_SIGNATURE");
  }
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      Buffer.from(`${input.timestamp}|${input.rawBody}`, "utf8"),
      publicKey,
      signature,
    )
  ) {
    throw new SmsWebhookError("INVALID_SIGNATURE");
  }
}

function errorCodeFromTelnyx(body: unknown): string | null {
  const parsed = telnyxErrorResponseSchema.safeParse(body);
  const code = parsed.success ? parsed.data.errors?.[0]?.code : undefined;
  return code === undefined ? null : String(code);
}

function telnyxHttpError(status: number, body: unknown): SmsProviderError {
  const providerCode = errorCodeFromTelnyx(body);
  if (providerCode === "40300") {
    return new SmsProviderError("RECIPIENT_OPTED_OUT", false);
  }
  if ([408, 409, 425, 429].includes(status)) {
    return new SmsProviderError(
      status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
      true,
    );
  }
  if (status >= 500) {
    return new SmsProviderError("PROVIDER_UNAVAILABLE", true);
  }
  if (["30003", "30005", "30006"].includes(providerCode ?? "")) {
    return new SmsProviderError("INVALID_DESTINATION", false);
  }
  return new SmsProviderError("PROVIDER_REJECTED", false);
}

export class TelnyxSmsProvider implements SmsProvider {
  readonly name = "telnyx" as const;
  readonly sender: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly config: TelnyxConfig,
    dependencies: TelnyxDependencies = {},
  ) {
    this.sender = config.fromNumber;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  async send(message: OutboundSms) {
    const validated = outboundSmsSchema.parse(message);
    if (validated.from !== this.sender) {
      throw new SmsProviderError("PROVIDER_REJECTED", false);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(TELNYX_MESSAGES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: validated.from,
          to: validated.to,
          text: validated.body,
          type: "SMS",
          encoding: "gsm7",
        }),
      });
    } catch {
      throw new SmsProviderError("NETWORK_ERROR", true);
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A safe classification is enough; never surface a raw response body.
    }
    if (!response.ok) throw telnyxHttpError(response.status, body);
    const parsed = telnyxSendResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SmsProviderError("INVALID_PROVIDER_RESPONSE", false);
    }
    return { providerMessageId: parsed.data.data.id };
  }

  async parseInboundWebhook(request: Request): Promise<InboundSms | null> {
    const rawBody = await request.text();
    verifyTelnyxWebhookSignature({
      rawBody,
      signature: request.headers.get("telnyx-signature-ed25519"),
      timestamp: request.headers.get("telnyx-timestamp"),
      publicKey: this.config.publicKey,
      now: this.now(),
    });

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new SmsWebhookError("INVALID_PAYLOAD");
    }
    const parsed = telnyxWebhookSchema.safeParse(json);
    if (!parsed.success) throw new SmsWebhookError("INVALID_PAYLOAD");
    if (parsed.data.data.event_type !== "message.received") return null;

    const event = parsed.data.data;
    const payload = event.payload;
    if (payload.to[0].phone_number !== this.sender) {
      throw new SmsWebhookError("INVALID_PAYLOAD");
    }
    return {
      provider: this.name,
      providerEventId: event.id,
      providerMessageId: payload.id,
      from: payload.from.phone_number,
      to: payload.to[0].phone_number,
      body: payload.text,
      receivedAt: new Date(payload.received_at ?? event.occurred_at),
      compliance: payload.autoresponse_type ?? null,
    };
  }
}
