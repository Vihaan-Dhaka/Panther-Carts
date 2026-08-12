export type SmsProviderErrorCode =
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_DESTINATION"
  | "RECIPIENT_OPTED_OUT"
  | "PROVIDER_REJECTED"
  | "INVALID_MESSAGE_TEMPLATE"
  | "INVALID_PROVIDER_RESPONSE";

/** Safe provider failure. Raw provider responses, credentials, and PII stay out. */
export class SmsProviderError extends Error {
  constructor(
    readonly code: SmsProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super(`SMS delivery failed: ${code}`);
    this.name = "SmsProviderError";
  }
}

export class SmsWebhookError extends Error {
  constructor(readonly kind: "INVALID_SIGNATURE" | "INVALID_PAYLOAD") {
    super(`SMS webhook rejected: ${kind}`);
    this.name = "SmsWebhookError";
  }
}
