import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as runOutbox } from "@/app/api/internal/sms-outbox/route";
import { POST as receiveTelnyx } from "@/app/api/sms/telnyx/route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SMS route safety", () => {
  it("rejects a missing worker bearer secret without exposing configuration", async () => {
    vi.stubEnv("SMS_OUTBOX_WORKER_SECRET", "x".repeat(32));
    const response = await runOutbox(
      new Request("https://example.com/api/internal/sms-outbox", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("returns a body-free 403 for an unsigned selected-provider webhook", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SMS_PROVIDER", "telnyx");
    vi.stubEnv("SMS_FROM_NUMBER", "+14045550100");
    vi.stubEnv("TELNYX_API_KEY", "key");
    vi.stubEnv("TELNYX_PUBLIC_KEY", Buffer.alloc(32, 1).toString("base64"));
    const response = await receiveTelnyx(
      new Request("https://example.com/api/sms/telnyx", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        component: "panther-carts-sms",
        event: "WEBHOOK_REJECTED",
        provider: "telnyx",
        outcome: "INVALID_SIGNATURE",
      }),
    );
  });
});
