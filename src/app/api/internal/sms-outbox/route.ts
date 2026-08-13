import { timingSafeEqual } from "node:crypto";
import { drainSmsOutbox } from "@/lib/sms/outbox";
import { createSmsProvider } from "@/lib/sms/provider";
import { recordSmsOperationalEvent } from "@/lib/sms/telemetry";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  outboxAuthorizationHeaderSchema,
  outboxWorkerSecretSchema,
} from "@/lib/validation/sms";

export const runtime = "nodejs";

function authorized(request: Request): boolean {
  const configured = outboxWorkerSecretSchema.safeParse(
    process.env.SMS_OUTBOX_WORKER_SECRET,
  );
  if (!configured.success) return false;
  const header = outboxAuthorizationHeaderSchema.safeParse(
    request.headers.get("authorization"),
  );
  if (!header.success) return false;
  const supplied = header.data;
  const expectedBytes = Buffer.from(configured.data);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return new Response(null, { status: 401 });
  try {
    const result = await drainSmsOutbox(
      createAdminClient(),
      createSmsProvider(),
    );
    if (result.failed > 0 || result.unconfirmed > 0) {
      recordSmsOperationalEvent("OUTBOX_REQUIRES_ATTENTION", result);
    }
    return Response.json(result);
  } catch {
    recordSmsOperationalEvent("OUTBOX_DRAIN_FAILED");
    return Response.json({ error: "Outbox delivery failed" }, { status: 500 });
  }
}
