import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SmsProviderError } from "./errors";
import { assertSingleGsm7Segment } from "./gsm";
import type { SmsProvider } from "./types";
import {
  claimedOutboxRowSchema,
  outboxCompletionSchema,
} from "@/lib/validation/sms";
import { z } from "zod";

export type OutboxDatabaseClient = Pick<SupabaseClient, "rpc">;

const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 20;
export const OUTBOX_LEASE_SECONDS = 120;

export type OutboxDrainResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  /** Provider/database completion could not be committed under this claim. */
  unconfirmed: number;
};

function safeFailure(error: unknown): { retryable: boolean; code: string } {
  if (error instanceof SmsProviderError) {
    return { retryable: error.retryable, code: error.code };
  }
  return { retryable: true, code: "UNEXPECTED_DELIVERY_ERROR" };
}

async function completeFailure(
  client: OutboxDatabaseClient,
  input: {
    id: string;
    claimToken: string;
    retryable: boolean;
    code: string;
  },
): Promise<boolean> {
  const { data, error } = await client.rpc(
    "complete_notification_outbox_failure",
    {
      p_outbox_id: input.id,
      p_claim_token: input.claimToken,
      p_retryable: input.retryable,
      p_error: input.code,
      p_max_attempts: MAX_ATTEMPTS,
    },
  );
  if (error) return false;
  const parsed = outboxCompletionSchema.safeParse(data);
  if (!parsed.success) return false;
  return parsed.data;
}

export async function drainSmsOutbox(
  client: OutboxDatabaseClient,
  provider: SmsProvider,
  options: { batchSize?: number } = {},
): Promise<OutboxDrainResult> {
  const batchSize = Math.min(
    100,
    Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)),
  );
  const { data, error } = await client.rpc("claim_notification_outbox", {
    p_worker_id: randomUUID(),
    p_limit: batchSize,
    p_lease_seconds: OUTBOX_LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw new Error("Outbox claim failed");
  const rows = z.array(claimedOutboxRowSchema).safeParse(data);
  if (!rows.success) throw new Error("Outbox claim failed");

  const result: OutboxDrainResult = {
    claimed: rows.data.length,
    sent: 0,
    retried: 0,
    failed: 0,
    unconfirmed: 0,
  };
  for (const row of rows.data) {
    try {
      try {
        assertSingleGsm7Segment(row.body);
      } catch {
        throw new SmsProviderError("INVALID_MESSAGE_TEMPLATE", false);
      }
      const sent = await provider.send({
        from: provider.sender,
        to: row.destination_phone,
        body: row.body,
      });
      const completion = await client.rpc("complete_notification_outbox_sent", {
        p_outbox_id: row.id,
        p_claim_token: row.claim_token,
        p_provider_message_id: sent.providerMessageId,
      });
      const completed = outboxCompletionSchema.safeParse(completion.data);
      if (completion.error || !completed.success || !completed.data) {
        // Provider acceptance is irreversible. Never report SENT or convert
        // this into an ordinary retry when the claim can no longer commit.
        result.unconfirmed += 1;
        continue;
      }
      result.sent += 1;
    } catch (error) {
      const failure = safeFailure(error);
      const completed = await completeFailure(client, {
        id: row.id,
        claimToken: row.claim_token,
        retryable: failure.retryable,
        code: failure.code,
      });
      if (!completed) {
        result.unconfirmed += 1;
        continue;
      }
      if (failure.retryable && row.attempts < MAX_ATTEMPTS) result.retried += 1;
      else result.failed += 1;
    }
  }
  return result;
}
