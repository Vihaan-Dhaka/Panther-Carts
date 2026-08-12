import "server-only";

import { SmsWebhookError } from "./errors";
import { dispatchInboundSms } from "./inbound";
import { drainSmsOutbox } from "./outbox";
import { createSmsProvider } from "./provider";
import type { SmsProviderName } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

export async function handleSmsWebhook(
  expectedProvider: SmsProviderName,
  request: Request,
): Promise<Response> {
  let provider;
  try {
    provider = createSmsProvider();
  } catch {
    return new Response(null, { status: 503 });
  }
  if (provider.name !== expectedProvider) {
    return new Response(null, { status: 404 });
  }

  try {
    const inbound = await provider.parseInboundWebhook(request);
    if (!inbound) return new Response(null, { status: 204 });
    const client = createAdminClient();
    await dispatchInboundSms(client, inbound);
    try {
      await drainSmsOutbox(client, provider, { batchSize: 10 });
    } catch {
      // The database transaction committed. The authenticated worker will retry.
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof SmsWebhookError) {
      return new Response(null, {
        status: error.kind === "INVALID_SIGNATURE" ? 403 : 400,
      });
    }
    return new Response(null, { status: 500 });
  }
}
