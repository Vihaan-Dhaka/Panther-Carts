/**
 * Domain error tokens raised by the queue-engine SQL functions. Each RPC
 * raises `PANTHER_CARTS:<TOKEN>` on a rule violation; server operations map
 * these to user-facing messages / HTTP statuses in later tickets.
 */
export const QUEUE_ERROR_PREFIX = "PANTHER_CARTS:";

export const QueueErrorCode = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  INVALID_STUDENT_INPUT: "INVALID_STUDENT_INPUT",
  DUPLICATE_ACTIVE_ENTRY: "DUPLICATE_ACTIVE_ENTRY",
  ENTRY_NOT_FOUND: "ENTRY_NOT_FOUND",
  ENTRY_NOT_READY: "ENTRY_NOT_READY",
  RESERVATION_NOT_ACTIVE: "RESERVATION_NOT_ACTIVE",
  RESERVATION_EXPIRED: "RESERVATION_EXPIRED",
  HOLD_ALREADY_USED: "HOLD_ALREADY_USED",
  NOBODY_WAITING: "NOBODY_WAITING",
  PANTHERCARD_REQUIRED: "PANTHERCARD_REQUIRED",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  PICKUP_CODE_INVALID: "PICKUP_CODE_INVALID",
  PICKUP_CODE_EXHAUSTED: "PICKUP_CODE_EXHAUSTED",
  BIN_NOT_FOUND: "BIN_NOT_FOUND",
  BIN_NOT_USABLE: "BIN_NOT_USABLE",
  NO_ACTIVE_RENTAL: "NO_ACTIVE_RENTAL",
} as const;

export type QueueErrorCode =
  (typeof QueueErrorCode)[keyof typeof QueueErrorCode];

/** Extract the domain token from a raised Postgres error message, if present. */
export function parseQueueErrorCode(message: string): QueueErrorCode | null {
  const index = message.indexOf(QUEUE_ERROR_PREFIX);
  if (index === -1) {
    return null;
  }
  const token = message
    .slice(index + QUEUE_ERROR_PREFIX.length)
    .trim()
    .split(/\s/)[0];
  const codes = Object.values(QueueErrorCode) as string[];
  return codes.includes(token) ? (token as QueueErrorCode) : null;
}
