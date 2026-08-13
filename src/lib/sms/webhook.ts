import "server-only";

import { SmsWebhookError } from "./errors";
import { dispatchInboundSms } from "./inbound";
import { createSmsProvider } from "./provider";
import { recordSmsOperationalEvent } from "./telemetry";
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
    recordSmsOperationalEvent("PROVIDER_CONFIGURATION_REJECTED", {
      provider: expectedProvider,
    });
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
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof SmsWebhookError) {
      recordSmsOperationalEvent("WEBHOOK_REJECTED", {
        provider: expectedProvider,
        outcome: error.kind,
      });
      return new Response(null, {
        status: error.kind === "INVALID_SIGNATURE" ? 403 : 400,
      });
    }
    recordSmsOperationalEvent("WEBHOOK_FAILED", {
      provider: expectedProvider,
      outcome: "UNEXPECTED_ERROR",
    });
    return new Response(null, { status: 500 });
  }
}
