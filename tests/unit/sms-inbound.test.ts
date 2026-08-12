import { describe, expect, it, vi } from "vitest";
import { dispatchInboundSms } from "@/lib/sms/inbound";
import type { InboundSms } from "@/lib/sms/types";

const base: InboundSms = {
  provider: "telnyx",
  providerEventId: "event-1",
  providerMessageId: "message-1",
  from: "+14045550123",
  to: "+14045550100",
  body: " time ",
  receivedAt: new Date("2026-08-11T20:00:00Z"),
  compliance: null,
};

describe("inbound SMS dispatch", () => {
  it("passes a normalized command and provider identifiers to one atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        duplicate: false,
        outcome: "TIME_WAITING",
        response_outbox_id: null,
      },
      error: null,
    });
    await dispatchInboundSms({ rpc } as never, base);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("handle_inbound_sms", {
      p_provider: "telnyx",
      p_provider_event_id: "event-1",
      p_provider_message_id: "message-1",
      p_from_phone: "+14045550123",
      p_to_phone: "+14045550100",
      p_received_at: "2026-08-11T20:00:00.000Z",
      p_command: "TIME",
      p_compliance: null,
    });
  });

  it.each(["STOP", "START", "UNSTOP", "HELP"])(
    "never dispatches %s as a queue command",
    async (body) => {
      const rpc = vi.fn().mockResolvedValue({
        data: {
          duplicate: false,
          outcome: "COMPLIANCE_ACKNOWLEDGED",
          response_outbox_id: null,
        },
        error: null,
      });
      await dispatchInboundSms({ rpc } as never, { ...base, body });
      expect(rpc).toHaveBeenCalledWith(
        "handle_inbound_sms",
        expect.objectContaining({
          p_command: "UNKNOWN",
          p_compliance: body === "UNSTOP" ? "START" : body,
        }),
      );
    },
  );
});
