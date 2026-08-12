import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSmsCommand } from "./commands";
import type { InboundSms } from "./types";
import {
  inboundDispatchResponseSchema,
  inboundDispatchSchema,
} from "@/lib/validation/sms";

export type InboundDatabaseClient = Pick<SupabaseClient, "rpc">;

export async function dispatchInboundSms(
  client: InboundDatabaseClient,
  inbound: InboundSms,
): Promise<{ duplicate: boolean; outcome: string }> {
  const parsedCommand = parseSmsCommand(inbound.body);
  const compliance =
    inbound.compliance ??
    (parsedCommand.kind === "compliance" ? parsedCommand.classification : null);
  const command =
    parsedCommand.kind === "command" ? parsedCommand.command : "UNKNOWN";
  const input = inboundDispatchSchema.parse({
    ...inbound,
    command,
    compliance,
  });

  const { data, error } = await client.rpc("handle_inbound_sms", {
    p_provider: input.provider,
    p_provider_event_id: input.providerEventId,
    p_provider_message_id: input.providerMessageId,
    p_from_phone: input.from,
    p_to_phone: input.to,
    p_received_at: input.receivedAt.toISOString(),
    p_command: input.command,
    p_compliance: input.compliance,
  });
  if (error) throw new Error("Inbound SMS operation failed");
  const result = inboundDispatchResponseSchema.safeParse(data);
  if (!result.success) throw new Error("Inbound SMS operation failed");
  return { duplicate: result.data.duplicate, outcome: result.data.outcome };
}
