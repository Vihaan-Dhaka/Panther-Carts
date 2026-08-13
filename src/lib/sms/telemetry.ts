import "server-only";

import type { SmsProviderName } from "./types";

type SmsOperationalEvent =
  | "PROVIDER_CONFIGURATION_REJECTED"
  | "WEBHOOK_REJECTED"
  | "WEBHOOK_FAILED"
  | "OUTBOX_REQUIRES_ATTENTION"
  | "OUTBOX_DRAIN_FAILED";

type SmsOperationalFields = {
  provider?: SmsProviderName;
  outcome?: "INVALID_SIGNATURE" | "INVALID_PAYLOAD" | "UNEXPECTED_ERROR";
  claimed?: number;
  sent?: number;
  retried?: number;
  failed?: number;
  unconfirmed?: number;
};

/** Emit only fixed outcome codes and aggregate counts; never pass PII here. */
export function recordSmsOperationalEvent(
  event: SmsOperationalEvent,
  fields: SmsOperationalFields = {},
): void {
  console.warn(
    JSON.stringify({ component: "panther-carts-sms", event, ...fields }),
  );
}
