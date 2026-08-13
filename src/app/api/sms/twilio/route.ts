import { handleSmsWebhook } from "@/lib/sms/webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleSmsWebhook("twilio", request);
}
