import "server-only";

import { z } from "zod";
import { TelnyxSmsProvider } from "./telnyx";
import { TwilioSmsProvider } from "./twilio";
import type { SmsProvider } from "./types";
import { e164Schema } from "@/lib/validation/sms";

type ProviderDependencies = { fetch?: typeof fetch; now?: () => Date };

const commonSchema = z.object({
  SMS_PROVIDER: z.enum(["telnyx", "twilio"]),
  SMS_FROM_NUMBER: e164Schema,
});

const telnyxPublicKeySchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.includes("BEGIN PUBLIC KEY")) return true;
    try {
      return Buffer.from(value, "base64").length === 32;
    } catch {
      return false;
    }
  }, "TELNYX_PUBLIC_KEY must be a PEM or base64 Ed25519 public key");

const telnyxSchema = commonSchema.extend({
  SMS_PROVIDER: z.literal("telnyx"),
  TELNYX_API_KEY: z.string().min(1),
  TELNYX_PUBLIC_KEY: telnyxPublicKeySchema,
});

const twilioSchema = commonSchema.extend({
  SMS_PROVIDER: z.literal("twilio"),
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_MESSAGING_SERVICE_SID: z.string().regex(/^MG[0-9a-fA-F]{32}$/),
  TWILIO_WEBHOOK_URL: z
    .string()
    .url()
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "TWILIO_WEBHOOK_URL must be HTTP(S)",
    ),
});

/** Validate only the credentials required by the explicitly selected provider. */
export function createSmsProvider(
  environment: Record<string, string | undefined> = process.env,
  dependencies: ProviderDependencies = {},
): SmsProvider {
  const selected = commonSchema.shape.SMS_PROVIDER.safeParse(
    environment.SMS_PROVIDER,
  );
  if (!selected.success) {
    throw new Error('SMS_PROVIDER must be exactly "telnyx" or "twilio"');
  }

  if (selected.data === "telnyx") {
    const config = telnyxSchema.parse(environment);
    return new TelnyxSmsProvider(
      {
        apiKey: config.TELNYX_API_KEY,
        publicKey: config.TELNYX_PUBLIC_KEY,
        fromNumber: config.SMS_FROM_NUMBER,
      },
      dependencies,
    );
  }

  const config = twilioSchema.parse(environment);
  return new TwilioSmsProvider(
    {
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
      fromNumber: config.SMS_FROM_NUMBER,
      webhookUrl: config.TWILIO_WEBHOOK_URL,
    },
    dependencies,
  );
}
