import { z } from "zod";

export const e164Schema = z.string().regex(/^\+\d{10,15}$/);

export const outboundSmsSchema = z.object({
  from: e164Schema,
  to: e164Schema,
  body: z.string().min(1).max(1_600),
});

export const telnyxSendResponseSchema = z.object({
  data: z.object({ id: z.string().min(1).max(200) }),
});

export const telnyxErrorResponseSchema = z.object({
  errors: z
    .array(z.object({ code: z.union([z.string(), z.number()]).optional() }))
    .optional(),
});

export const telnyxWebhookSchema = z.object({
  data: z.object({
    event_type: z.string(),
    id: z.string().min(1).max(200),
    occurred_at: z.string().datetime({ offset: true }),
    payload: z.object({
      id: z.string().min(1).max(200),
      from: z.object({ phone_number: e164Schema }),
      to: z.array(z.object({ phone_number: e164Schema })).min(1),
      text: z.string().max(1_600).default(""),
      received_at: z.string().datetime({ offset: true }).optional(),
      autoresponse_type: z.enum(["STOP", "START", "HELP"]).optional(),
    }),
  }),
});

export const twilioSendResponseSchema = z.object({
  sid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/),
});

export const twilioErrorResponseSchema = z.object({
  code: z.number().int().optional(),
});

export const twilioInboundSchema = z.object({
  MessageSid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/),
  From: e164Schema,
  To: e164Schema,
  Body: z.string().max(1_600).default(""),
  OptOutType: z.enum(["STOP", "START", "HELP"]).optional(),
  DateCreated: z.string().optional(),
});

export const inboundDispatchSchema = z.object({
  provider: z.enum(["telnyx", "twilio"]),
  providerEventId: z.string().min(1).max(200),
  providerMessageId: z.string().min(1).max(200),
  from: e164Schema,
  to: e164Schema,
  receivedAt: z.date(),
  command: z.enum(["TIME", "HOLD", "CANCEL", "UNKNOWN"]),
  compliance: z.enum(["STOP", "START", "HELP"]).nullable(),
});

export const outboxWorkerSecretSchema = z.string().min(32).max(512);
export const outboxAuthorizationHeaderSchema = z
  .string()
  .regex(/^Bearer [!-~]{32,512}$/)
  .transform((value) => value.slice(7));

export const inboundDispatchResponseSchema = z.object({
  duplicate: z.boolean(),
  outcome: z.string().min(1).max(80),
  response_outbox_id: z.uuid().nullable(),
});

export const claimedOutboxRowSchema = z.object({
  id: z.uuid(),
  destination_phone: e164Schema,
  body: z.string().min(1).max(1_600),
  attempts: z.number().int().positive(),
  claim_token: z.uuid(),
});

export const outboxCompletionSchema = z.boolean();
