/**
 * Provider-independent SMS contract. Concrete adapters (Telnyx, Twilio) will
 * implement this interface in Ticket 5 — no provider SDK is imported yet.
 */

export interface OutboundSms {
  /** E.164 destination number, e.g. +15551234567 */
  to: string;
  body: string;
}

export interface InboundSms {
  /** E.164 sender number */
  from: string;
  /** Raw message body; command parsing (TIME/HOLD/CANCEL/HELP) happens elsewhere */
  body: string;
  receivedAt: Date;
}

export interface SmsProvider {
  send(message: OutboundSms): Promise<{ providerMessageId: string }>;
  /**
   * Verify and parse an inbound webhook request from the provider.
   * Returns null when the request is not a valid inbound message.
   */
  parseInboundWebhook(request: Request): Promise<InboundSms | null>;
}

/** Recognized inbound SMS commands. */
export const SMS_COMMANDS = ["TIME", "HOLD", "CANCEL", "HELP"] as const;
export type SmsCommand = (typeof SMS_COMMANDS)[number];
