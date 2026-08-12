import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { SmsProviderError, SmsWebhookError } from "./errors";
import {
  SMS_PROVIDER_REQUEST_TIMEOUT_MS,
  type InboundSms,
  type OutboundSms,
  type SmsProvider,
} from "./types";
import {
  outboundSmsSchema,
  twilioErrorResponseSchema,
  twilioInboundSchema,
  twilioSendResponseSchema,
} from "@/lib/validation/sms";

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  fromNumber: string;
  webhookUrl: string;
};

type TwilioDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
};

type TwilioParameters = Record<string, string | string[]>;

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function computeTwilioSignature(
  authToken: string,
  exactUrl: string,
  parameters: TwilioParameters,
): string {
  let payload = exactUrl;
  for (const key of Object.keys(parameters).sort()) {
    const value = parameters[key];
    const values = Array.isArray(value) ? [...new Set(value)].sort() : [value];
    for (const item of values) payload += `${key}${item}`;
  }
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

export function verifyTwilioWebhookSignature(input: {
  authToken: string;
  exactUrl: string;
  parameters: TwilioParameters;
  signature: string | null;
}): void {
  if (
    !input.signature ||
    !constantTimeEqual(
      computeTwilioSignature(input.authToken, input.exactUrl, input.parameters),
      input.signature,
    )
  ) {
    throw new SmsWebhookError("INVALID_SIGNATURE");
  }
}

function formParameters(form: URLSearchParams): TwilioParameters {
  const result: TwilioParameters = {};
  for (const [key, value] of form.entries()) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}

function twilioHttpError(status: number, body: unknown): SmsProviderError {
  const parsed = twilioErrorResponseSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;
  if (code === 21610) {
    return new SmsProviderError("RECIPIENT_OPTED_OUT", false);
  }
  if ([21211, 21612, 21614].includes(code ?? -1)) {
    return new SmsProviderError("INVALID_DESTINATION", false);
  }
  if (status === 429) return new SmsProviderError("RATE_LIMITED", true);
  if ([408, 409, 425].includes(status) || status >= 500) {
    return new SmsProviderError("PROVIDER_UNAVAILABLE", true);
  }
  return new SmsProviderError("PROVIDER_REJECTED", false);
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio" as const;
  readonly sender: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: TwilioConfig,
    dependencies: TwilioDependencies = {},
  ) {
    this.sender = config.fromNumber;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.requestTimeoutMs =
      dependencies.requestTimeoutMs ?? SMS_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  async send(message: OutboundSms) {
    const validated = outboundSmsSchema.parse(message);
    if (validated.from !== this.sender) {
      throw new SmsProviderError("PROVIDER_REJECTED", false);
    }
    const form = new URLSearchParams({
      To: validated.to,
      From: validated.from,
      MessagingServiceSid: this.config.messagingServiceSid,
      Body: validated.body,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(
              `${this.config.accountSid}:${this.config.authToken}`,
            ).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      throw new SmsProviderError("NETWORK_ERROR", true);
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Deliberately discard raw provider content.
    }
    if (!response.ok) throw twilioHttpError(response.status, body);
    const parsed = twilioSendResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SmsProviderError("INVALID_PROVIDER_RESPONSE", false);
    }
    return { providerMessageId: parsed.data.sid };
  }

  async parseInboundWebhook(request: Request): Promise<InboundSms | null> {
    const contentType = request.headers.get("content-type") ?? "";
    if (
      !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
    ) {
      throw new SmsWebhookError("INVALID_PAYLOAD");
    }
    const rawBody = await request.text();
    const form = new URLSearchParams(rawBody);
    const parameters = formParameters(form);
    verifyTwilioWebhookSignature({
      authToken: this.config.authToken,
      exactUrl: this.config.webhookUrl,
      parameters,
      signature: request.headers.get("x-twilio-signature"),
    });

    const flat = Object.fromEntries(
      Object.entries(parameters).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[value.length - 1] : value,
      ]),
    );
    const parsed = twilioInboundSchema.safeParse(flat);
    if (!parsed.success) throw new SmsWebhookError("INVALID_PAYLOAD");
    const inbound = parsed.data;
    if (inbound.To !== this.sender) {
      throw new SmsWebhookError("INVALID_PAYLOAD");
    }
    const suppliedTimestamp = inbound.DateCreated
      ? new Date(inbound.DateCreated)
      : null;
    return {
      provider: this.name,
      providerEventId: inbound.MessageSid,
      providerMessageId: inbound.MessageSid,
      from: inbound.From,
      to: inbound.To,
      body: inbound.Body,
      receivedAt:
        suppliedTimestamp && !Number.isNaN(suppliedTimestamp.getTime())
          ? suppliedTimestamp
          : this.now(),
      compliance: inbound.OptOutType ?? null,
    };
  }
}
