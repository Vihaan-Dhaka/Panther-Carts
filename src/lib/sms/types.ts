export const SMS_PROVIDERS = ["telnyx", "twilio"] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

export interface OutboundSms {
  /** E.164 sender and destination numbers. */
  from: string;
  to: string;
  body: string;
}

export type SmsComplianceClassification = "STOP" | "START" | "HELP";

export interface InboundSms {
  provider: SmsProviderName;
  /** Provider-scoped webhook and message identifiers used for idempotency. */
  providerEventId: string;
  providerMessageId: string;
  /** E.164 sender and destination numbers. */
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  /** Set when the provider already handled and replied to a compliance keyword. */
  compliance: SmsComplianceClassification | null;
}

export interface SmsSendResult {
  providerMessageId: string;
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  readonly sender: string;
  send(message: OutboundSms): Promise<SmsSendResult>;
  /** Verify the exact request before parsing any trusted webhook fields. */
  parseInboundWebhook(request: Request): Promise<InboundSms | null>;
}

/** Panther Carts queue commands. Carrier compliance keywords are separate. */
export const SMS_COMMANDS = ["TIME", "HOLD", "CANCEL"] as const;
export type SmsCommand = (typeof SMS_COMMANDS)[number];
