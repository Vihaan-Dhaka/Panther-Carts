import { describe, expect, it, vi } from "vitest";
import { SmsProviderError } from "@/lib/sms/errors";
import {
  drainSmsOutbox,
  MAX_OUTBOX_BATCH_SIZE,
  OUTBOX_DATABASE_REQUEST_TIMEOUT_MS,
  OUTBOX_LEASE_SAFETY_MS,
  OUTBOX_LEASE_SECONDS,
} from "@/lib/sms/outbox";
import {
  SMS_PROVIDER_REQUEST_TIMEOUT_MS,
  type SmsProvider,
} from "@/lib/sms/types";

const row = {
  id: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9",
  destination_phone: "+14045550123",
  body: "Panther Carts: Test. STOP=opt out.",
  attempts: 1,
  claim_token: "6c395a6e-87aa-4932-b1f0-1dd506bfe15d",
  lease_expires_at: "2099-01-01T00:00:00.000Z",
};

function clientWith(rows = [row]) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_notification_outbox") {
      return { data: rows, error: null };
    }
    return { data: true, error: null };
  });
  return { client: { rpc } as never, rpc };
}

function provider(send: SmsProvider["send"]): SmsProvider {
  return {
    name: "telnyx",
    sender: "+14045550100",
    send,
    parseInboundWebhook: vi.fn(),
  };
}

describe("SMS outbox worker", () => {
  it("bounds the complete sequential batch comfortably inside the lease", () => {
    expect(
      MAX_OUTBOX_BATCH_SIZE * SMS_PROVIDER_REQUEST_TIMEOUT_MS +
        (MAX_OUTBOX_BATCH_SIZE + 1) * OUTBOX_DATABASE_REQUEST_TIMEOUT_MS +
        OUTBOX_LEASE_SAFETY_MS,
    ).toBeLessThanOrEqual(OUTBOX_LEASE_SECONDS * 1_000);
    expect(MAX_OUTBOX_BATCH_SIZE).toBe(3);
  });

  it("returns an unsent row to retry when its remaining lease cannot cover delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    try {
      const minimumSendBudget =
        SMS_PROVIDER_REQUEST_TIMEOUT_MS +
        OUTBOX_DATABASE_REQUEST_TIMEOUT_MS +
        OUTBOX_LEASE_SAFETY_MS;
      const expiringRow = {
        ...row,
        lease_expires_at: new Date(
          Date.now() + minimumSendBudget - 1,
        ).toISOString(),
      };
      const { client, rpc } = clientWith([expiringRow]);
      const send = vi.fn();

      await expect(drainSmsOutbox(client, provider(send))).resolves.toEqual({
        claimed: 1,
        sent: 0,
        retried: 1,
        failed: 0,
        unconfirmed: 0,
      });
      expect(send).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledWith(
        "complete_notification_outbox_failure",
        expect.objectContaining({
          p_retryable: true,
          p_error: "LEASE_BUDGET_EXHAUSTED",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled sent-completion RPC and reports provider acceptance as unconfirmed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    try {
      const { client, rpc } = clientWith([
        {
          ...row,
          lease_expires_at: new Date(
            Date.now() + OUTBOX_LEASE_SECONDS * 1_000,
          ).toISOString(),
        },
      ]);
      rpc.mockImplementation(async (name: string) => {
        if (name === "claim_notification_outbox") {
          return {
            data: [
              {
                ...row,
                lease_expires_at: new Date(
                  Date.now() + OUTBOX_LEASE_SECONDS * 1_000,
                ).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "complete_notification_outbox_sent") {
          return await new Promise(() => {});
        }
        return { data: true, error: null };
      });
      const drain = drainSmsOutbox(
        client,
        provider(vi.fn().mockResolvedValue({ providerMessageId: "message-1" })),
      );

      await vi.advanceTimersByTimeAsync(OUTBOX_DATABASE_REQUEST_TIMEOUT_MS + 1);
      await expect(drain).resolves.toMatchObject({
        sent: 0,
        unconfirmed: 1,
      });
      expect(rpc).not.toHaveBeenCalledWith(
        "complete_notification_outbox_failure",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a caller-requested batch at the lease-safe maximum", async () => {
    const { client, rpc } = clientWith([]);
    await drainSmsOutbox(client, provider(vi.fn()), { batchSize: 100 });
    expect(rpc).toHaveBeenCalledWith(
      "claim_notification_outbox",
      expect.objectContaining({ p_limit: MAX_OUTBOX_BATCH_SIZE }),
    );
  });

  it("sends a claimed row and records only the provider message ID", async () => {
    const { client, rpc } = clientWith();
    const send = vi.fn().mockResolvedValue({ providerMessageId: "message-1" });
    await expect(drainSmsOutbox(client, provider(send))).resolves.toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      unconfirmed: 0,
    });
    expect(send).toHaveBeenCalledWith({
      from: "+14045550100",
      to: "+14045550123",
      body: row.body,
    });
    expect(rpc).toHaveBeenCalledWith("complete_notification_outbox_sent", {
      p_outbox_id: row.id,
      p_claim_token: row.claim_token,
      p_provider_message_id: "message-1",
    });
  });

  it("does not report sent when provider acceptance cannot commit under the claim", async () => {
    const { client, rpc } = clientWith();
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_notification_outbox") {
        return { data: [row], error: null };
      }
      if (name === "complete_notification_outbox_sent") {
        return { data: false, error: null };
      }
      return { data: true, error: null };
    });
    const send = vi.fn().mockResolvedValue({ providerMessageId: "message-1" });

    await expect(drainSmsOutbox(client, provider(send))).resolves.toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 0,
      unconfirmed: 1,
    });
    expect(rpc).not.toHaveBeenCalledWith(
      "complete_notification_outbox_failure",
      expect.anything(),
    );
  });

  it("surfaces a rejected failure completion instead of claiming a retry", async () => {
    const { client, rpc } = clientWith();
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_notification_outbox") {
        return { data: [row], error: null };
      }
      return { data: false, error: null };
    });

    await expect(
      drainSmsOutbox(
        client,
        provider(
          vi
            .fn()
            .mockRejectedValue(new SmsProviderError("NETWORK_ERROR", true)),
        ),
      ),
    ).resolves.toMatchObject({
      sent: 0,
      retried: 0,
      failed: 0,
      unconfirmed: 1,
    });
  });

  it("returns temporary failures to retry and marks permanent failures failed", async () => {
    const temporary = clientWith();
    await expect(
      drainSmsOutbox(
        temporary.client,
        provider(
          vi.fn().mockRejectedValue(new SmsProviderError("RATE_LIMITED", true)),
        ),
      ),
    ).resolves.toMatchObject({ retried: 1, failed: 0 });
    expect(temporary.rpc).toHaveBeenCalledWith(
      "complete_notification_outbox_failure",
      expect.objectContaining({ p_retryable: true, p_error: "RATE_LIMITED" }),
    );

    const permanent = clientWith();
    await expect(
      drainSmsOutbox(
        permanent.client,
        provider(
          vi
            .fn()
            .mockRejectedValue(
              new SmsProviderError("RECIPIENT_OPTED_OUT", false),
            ),
        ),
      ),
    ).resolves.toMatchObject({ retried: 0, failed: 1 });
  });

  it("permanently rejects Unicode or multi-segment rows before a provider call", async () => {
    const invalid = { ...row, body: "Panther Carts \u2603" };
    const { client, rpc } = clientWith([invalid]);
    const send = vi.fn();
    await expect(drainSmsOutbox(client, provider(send))).resolves.toMatchObject(
      {
        failed: 1,
      },
    );
    expect(send).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "complete_notification_outbox_failure",
      expect.objectContaining({
        p_retryable: false,
        p_error: "INVALID_MESSAGE_TEMPLATE",
      }),
    );
  });
});
