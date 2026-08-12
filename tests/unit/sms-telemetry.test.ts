import { afterEach, describe, expect, it, vi } from "vitest";
import { recordSmsOperationalEvent } from "@/lib/sms/telemetry";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SMS operational telemetry", () => {
  it("emits only a fixed event and aggregate delivery counts", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    recordSmsOperationalEvent("OUTBOX_REQUIRES_ATTENTION", {
      claimed: 3,
      sent: 1,
      retried: 1,
      failed: 0,
      unconfirmed: 1,
    });

    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        component: "panther-carts-sms",
        event: "OUTBOX_REQUIRES_ATTENTION",
        claimed: 3,
        sent: 1,
        retried: 1,
        failed: 0,
        unconfirmed: 1,
      }),
    );
  });
});
