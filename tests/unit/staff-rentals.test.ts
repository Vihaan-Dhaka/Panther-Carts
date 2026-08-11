import { describe, expect, it, vi } from "vitest";
import { QueueErrorCode, QueueOperationError } from "@/lib/queue/errors";
import {
  checkoutRental,
  getCheckoutPreview,
  getReturnPreview,
  returnRental,
  type StaffRentalDatabaseClient,
} from "@/lib/queue/staff-rentals";

const SESSION_ID = "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9";
const ENTRY_ID = "81bbf354-a557-4d22-9da0-6574416c62f1";
const STUDENT_ID = "d7ce3cb5-dbf2-4caf-a9f2-1d76d676caa4";
const RESERVED_BIN_ID = "a83ee1cf-bd03-4d54-9272-bab9459c92db";
const AVAILABLE_BIN_ID = "1d149423-eed2-4d40-b486-9399b17eb33d";
const OTHER_BIN_ID = "80622a3a-bd0e-47d6-9c40-91c91e976a89";
const IDEMPOTENCY_KEY = "7b830507-034f-4746-9a67-f7e9184d40bc";

type Response = { data: unknown; error: { message: string } | null };

function query(response: Response) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn().mockResolvedValue(response);
  builder.maybeSingle = vi.fn().mockResolvedValue(response);
  return builder;
}

function fakeClient(
  tables: Record<string, Response>,
  rpcResponse: Response = { data: null, error: null },
) {
  const builders = Object.fromEntries(
    Object.entries(tables).map(([table, response]) => [table, query(response)]),
  );
  const from = vi.fn((table: string) => builders[table]);
  const rpc = vi.fn().mockResolvedValue(rpcResponse);
  return {
    client: { from, rpc } as unknown as StaffRentalDatabaseClient,
    from,
    rpc,
  };
}

function futureTime() {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

describe("staff checkout and return database wrappers", () => {
  it("returns only public student identity and eligible checkout bins", async () => {
    const { client } = fakeClient({
      queue_entries: {
        data: {
          id: ENTRY_ID,
          student_id: STUDENT_ID,
          reserved_bin_id: RESERVED_BIN_ID,
          pickup_expires_at: futureTime(),
          status: "READY",
        },
        error: null,
      },
      reservations: {
        data: {
          bin_id: RESERVED_BIN_ID,
          status: "ACTIVE",
          expires_at: futureTime(),
        },
        error: null,
      },
      students: {
        data: {
          full_name: "Jordan Panther",
          panther_id: "900123456",
          email: "private@example.edu",
          phone: "+14045550123",
          id: STUDENT_ID,
        },
        error: null,
      },
      bins: {
        data: [
          { id: RESERVED_BIN_ID, bin_number: "1", status: "RESERVED" },
          { id: AVAILABLE_BIN_ID, bin_number: "2", status: "AVAILABLE" },
          { id: OTHER_BIN_ID, bin_number: "3", status: "OUT" },
          {
            id: "70a4ebaf-e410-4148-a816-a26fcbf3a774",
            bin_number: "4",
            status: "RESERVED",
          },
        ],
        error: null,
      },
    });

    const preview = await getCheckoutPreview(client, SESSION_ID, "0427");

    expect(preview).toEqual({
      student: { fullName: "Jordan Panther", pantherId: "900123456" },
      eligibleBins: [
        { binNumber: "1", reserved: true },
        { binNumber: "2", reserved: false },
      ],
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /private@example|404555|student_id|reserved_bin_id|81bbf354/,
    );
  });

  it("rejects invalid, expired, inactive, and malformed checkout previews safely", async () => {
    const missing = fakeClient({
      queue_entries: { data: null, error: null },
    });
    await expect(
      getCheckoutPreview(missing.client, SESSION_ID, "0427"),
    ).rejects.toMatchObject({ code: QueueErrorCode.PICKUP_CODE_INVALID });

    const expired = fakeClient({
      queue_entries: {
        data: {
          id: ENTRY_ID,
          student_id: STUDENT_ID,
          reserved_bin_id: RESERVED_BIN_ID,
          pickup_expires_at: new Date(Date.now() - 1_000).toISOString(),
          status: "READY",
        },
        error: null,
      },
    });
    await expect(
      getCheckoutPreview(expired.client, SESSION_ID, "0427"),
    ).rejects.toMatchObject({ code: QueueErrorCode.RESERVATION_EXPIRED });

    const inactive = fakeClient({
      queue_entries: {
        data: {
          id: ENTRY_ID,
          student_id: STUDENT_ID,
          reserved_bin_id: RESERVED_BIN_ID,
          pickup_expires_at: futureTime(),
          status: "READY",
        },
        error: null,
      },
      reservations: { data: null, error: null },
    });
    await expect(
      getCheckoutPreview(inactive.client, SESSION_ID, "0427"),
    ).rejects.toMatchObject({ code: QueueErrorCode.RESERVATION_NOT_ACTIVE });

    const malformed = fakeClient({
      queue_entries: {
        data: {
          id: "raw internal id",
          student_id: STUDENT_ID,
          reserved_bin_id: RESERVED_BIN_ID,
          pickup_expires_at: futureTime(),
          status: "READY",
        },
        error: null,
      },
    });
    await expect(
      getCheckoutPreview(malformed.client, SESSION_ID, "0427"),
    ).rejects.toEqual(new QueueOperationError(null));
  });

  it("looks up an active return by physical bin number without exposing PII", async () => {
    const { client } = fakeClient({
      bins: {
        data: { id: RESERVED_BIN_ID, bin_number: "014", status: "OUT" },
        error: null,
      },
      rentals: {
        data: { student_id: STUDENT_ID, status: "OUT" },
        error: null,
      },
      students: {
        data: {
          full_name: "Jordan Panther",
          panther_id: "900123456",
          email: "private@example.edu",
          phone: "+14045550123",
        },
        error: null,
      },
    });

    const preview = await getReturnPreview(client, SESSION_ID, "014");
    expect(preview).toEqual({
      student: { fullName: "Jordan Panther", pantherId: "900123456" },
      binNumber: "014",
    });
    expect(JSON.stringify(preview)).not.toMatch(/email|phone|private@example/);
  });

  it.each([
    [null, QueueErrorCode.BIN_NOT_FOUND],
    [
      { id: RESERVED_BIN_ID, bin_number: "14", status: "AVAILABLE" },
      QueueErrorCode.NO_ACTIVE_RENTAL,
    ],
  ])("maps missing return data to %s", async (bin, code) => {
    const { client } = fakeClient({
      bins: { data: bin, error: null },
      rentals: { data: null, error: null },
    });
    await expect(
      getReturnPreview(client, SESSION_ID, "14"),
    ).rejects.toMatchObject({ code });
  });

  it("calls checkout with a safe default label and returns replay metadata", async () => {
    const { client, rpc } = fakeClient(
      {},
      {
        data: {
          rental: {
            session_id: SESSION_ID,
            bin_id: AVAILABLE_BIN_ID,
            student_id: STUDENT_ID,
            status: "OUT",
            due_at: "2026-08-11T20:00:00+00:00",
            panthercard_collected_at: "2026-08-11T19:00:00+00:00",
            checkout_idempotency_key: IDEMPOTENCY_KEY,
          },
          swapped: true,
          idempotent_replay: true,
        },
        error: null,
      },
    );

    await expect(
      checkoutRental(client, SESSION_ID, "0427", {
        binNumber: "2",
        pantherCardCollected: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toEqual({
      studentId: STUDENT_ID,
      dueAt: "2026-08-11T20:00:00+00:00",
      swapped: true,
      idempotentReplay: true,
    });
    expect(rpc).toHaveBeenCalledWith("checkout", {
      p_session_id: SESSION_ID,
      p_pickup_code: "0427",
      p_bin_number: "2",
      p_panthercard_collected: true,
      p_staff_label: "Staff station",
      p_idempotency_key: IDEMPOTENCY_KEY,
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("staff-secret-code");
  });

  it("calls return_rental and preserves authoritative allocation metadata", async () => {
    const { client, rpc } = fakeClient(
      {},
      {
        data: {
          rental: {
            session_id: SESSION_ID,
            bin_id: RESERVED_BIN_ID,
            student_id: STUDENT_ID,
            status: "RETURNED",
            was_late: false,
            panthercard_returned_at: "2026-08-11T19:00:00+00:00",
            return_idempotency_key: IDEMPOTENCY_KEY,
          },
          reservation: {
            id: "42aa10ce-237f-45c7-9345-29466cb33dbc",
            queue_entry_id: ENTRY_ID,
            bin_id: RESERVED_BIN_ID,
            status: "ACTIVE",
            expires_at: "2026-08-11T19:10:00+00:00",
          },
          idempotent_replay: false,
        },
        error: null,
      },
    );

    await expect(
      returnRental(client, SESSION_ID, {
        binNumber: "1",
        pantherCardReturned: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toEqual({
      studentId: STUDENT_ID,
      wasLate: false,
      nextReservationCreated: true,
      idempotentReplay: false,
    });
    expect(rpc).toHaveBeenCalledWith("return_rental", {
      p_session_id: SESSION_ID,
      p_bin_number: "1",
      p_panthercard_returned: true,
      p_staff_label: "Staff station",
      p_idempotency_key: IDEMPOTENCY_KEY,
    });
  });

  it("maps known RPC errors and rejects malformed RPC responses", async () => {
    const checkoutError = fakeClient(
      {},
      {
        data: null,
        error: { message: "PANTHER_CARTS:BIN_NOT_USABLE raw SQL detail" },
      },
    );
    await expect(
      checkoutRental(checkoutError.client, SESSION_ID, "0427", {
        binNumber: "2",
        pantherCardCollected: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: QueueErrorCode.BIN_NOT_USABLE });

    const malformed = fakeClient(
      {},
      {
        data: { rental: { student_id: STUDENT_ID }, idempotent_replay: false },
        error: null,
      },
    );
    await expect(
      returnRental(malformed.client, SESSION_ID, {
        binNumber: "1",
        pantherCardReturned: true,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toEqual(new QueueOperationError(null));
  });
});
