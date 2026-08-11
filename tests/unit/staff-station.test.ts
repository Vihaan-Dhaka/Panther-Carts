import { describe, expect, it, vi } from "vitest";
import type { StaffRentalDatabaseClient } from "@/lib/queue/staff-rentals";
import {
  executeCheckout,
  executeCheckoutLookup,
  executeReturn,
  executeReturnLookup,
  getStaffStationAvailability,
} from "@/lib/queue/staff-station";

const SESSION_ID = "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9";
const ENTRY_ID = "81bbf354-a557-4d22-9da0-6574416c62f1";
const STUDENT_ID = "d7ce3cb5-dbf2-4caf-a9f2-1d76d676caa4";
const BIN_ID = "a83ee1cf-bd03-4d54-9272-bab9459c92db";
const KEY = "7b830507-034f-4746-9a67-f7e9184d40bc";

type Response = { data: unknown; error: { message: string } | null };
type QueryBuilder = Record<string, ReturnType<typeof vi.fn>>;

function query(response: Response) {
  const builder: QueryBuilder = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.limit = vi.fn().mockResolvedValue(response);
  builder.maybeSingle = vi.fn().mockResolvedValue(response);
  return builder;
}

function fakeClient(options?: {
  session?: unknown;
  tables?: Record<string, Response | Response[]>;
  rpc?: Response;
}) {
  const tables: Record<string, Response | Response[]> = {
    sessions: {
      data:
        options && "session" in options
          ? options.session
          : { id: SESSION_ID, status: "ACTIVE" },
      error: null,
    },
    ...(options?.tables ?? {}),
  };
  const builders = Object.fromEntries(
    Object.entries(tables).map(([table, responses]) => [
      table,
      (Array.isArray(responses) ? responses : [responses]).map(query),
    ]),
  ) as Record<string, QueryBuilder[]>;
  const callIndexes: Record<string, number> = {};
  const from = vi.fn((table: string) => {
    const tableBuilders = builders[table];
    const index = callIndexes[table] ?? 0;
    callIndexes[table] = index + 1;
    return tableBuilders?.[Math.min(index, tableBuilders.length - 1)];
  });
  const rpc = vi
    .fn()
    .mockResolvedValue(options?.rpc ?? { data: null, error: null });
  return {
    client: { from, rpc } as unknown as StaffRentalDatabaseClient,
    builders,
    from,
    rpc,
  };
}

function checkoutRpcData(idempotentReplay = false): Response {
  return {
    data: {
      rental: {
        session_id: SESSION_ID,
        bin_id: BIN_ID,
        student_id: STUDENT_ID,
        status: "OUT",
        due_at: "2026-08-11T20:00:00+00:00",
        panthercard_collected_at: "2026-08-11T19:00:00+00:00",
        checkout_idempotency_key: KEY,
      },
      swapped: false,
      idempotent_replay: idempotentReplay,
    },
    error: null,
  };
}

function returnRpcData(idempotentReplay = false): Response {
  return {
    data: {
      rental: {
        session_id: SESSION_ID,
        bin_id: BIN_ID,
        student_id: STUDENT_ID,
        status: "RETURNED",
        was_late: false,
        panthercard_returned_at: "2026-08-11T19:00:00+00:00",
        return_idempotency_key: KEY,
      },
      reservation: null,
      idempotent_replay: idempotentReplay,
    },
    error: null,
  };
}

const publicStudentTable = {
  students: {
    data: { full_name: "Jordan Panther", panther_id: "900123456" },
    error: null,
  },
};

describe("staff station server operations", () => {
  it("resolves access only through the staff code column", async () => {
    const { client, builders } = fakeClient();

    await expect(
      getStaffStationAvailability(client, "staff-secret"),
    ).resolves.toEqual({ available: true });
    expect(builders.sessions[0].select).toHaveBeenCalledWith("id,status");
    expect(builders.sessions[0].eq).toHaveBeenCalledOnce();
    expect(builders.sessions[0].eq).toHaveBeenCalledWith(
      "staff_code",
      "staff-secret",
    );
  });

  it.each([
    [null, "invalid"],
    [{ id: SESSION_ID, status: "DRAFT" }, "not active"],
    [{ id: SESSION_ID, status: "CLOSED" }, "not active"],
  ])(
    "handles unknown and inactive staff sessions safely",
    async (session, message) => {
      const { client } = fakeClient({ session });
      const result = await getStaffStationAvailability(client, "staff-secret");

      expect(result.available).toBe(false);
      expect(JSON.stringify(result)).toContain(message);
      expect(JSON.stringify(result)).not.toContain(SESSION_ID);
      expect(JSON.stringify(result)).not.toContain("staff-secret");
    },
  );

  it("rejects malformed pickup codes before any database lookup", async () => {
    const { client, from } = fakeClient();
    const state = await executeCheckoutLookup(client, "staff-secret", {
      pickupCode: "12a",
    });

    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).toContain("four-digit");
    expect(from).not.toHaveBeenCalled();
  });

  it("creates a server-validated UUID for one checkout confirmation attempt", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { client } = fakeClient({
      tables: {
        queue_entries: {
          data: {
            id: ENTRY_ID,
            student_id: STUDENT_ID,
            reserved_bin_id: BIN_ID,
            pickup_expires_at: future,
            status: "READY",
          },
          error: null,
        },
        reservations: {
          data: { bin_id: BIN_ID, status: "ACTIVE", expires_at: future },
          error: null,
        },
        students: publicStudentTable.students,
        bins: [
          {
            data: { id: BIN_ID, bin_number: "1", status: "RESERVED" },
            error: null,
          },
          { data: [], error: null },
        ],
      },
    });

    const state = await executeCheckoutLookup(client, "staff-secret", {
      pickupCode: "0427",
    });

    expect(state.status).toBe("preview");
    if (state.status === "preview") {
      expect(state.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(state.idempotencyKey).not.toContain("900123456");
    }
  });

  it("requires PantherCard collection and preserves selected values", async () => {
    const { client, rpc } = fakeClient();
    const state = await executeCheckout(client, "staff-secret", "0427", KEY, {
      binNumber: "2",
      pantherCardCollected: null,
    });

    expect(state).toMatchObject({
      status: "error",
      values: { binNumber: "2", pantherCardCollected: false },
    });
    expect(JSON.stringify(state)).toContain("PantherCard");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["PICKUP_CODE_INVALID", "pickup code"],
    ["RESERVATION_NOT_ACTIVE", "no longer active"],
    ["RESERVATION_EXPIRED", "expired"],
    ["BIN_NOT_FOUND", "does not exist"],
    ["BIN_NOT_USABLE", "no longer eligible"],
    ["PANTHERCARD_REQUIRED", "PantherCard"],
    ["IDEMPOTENCY_KEY_REQUIRED", "confirmation expired"],
    ["IDEMPOTENCY_CONFLICT", "already used"],
  ])("maps checkout %s to a safe workflow message", async (code, message) => {
    const { client } = fakeClient({
      rpc: {
        data: null,
        error: { message: `PANTHER_CARTS:${code} secret SQL and row id` },
      },
    });
    const state = await executeCheckout(client, "staff-secret", "0427", KEY, {
      binNumber: "1",
      pantherCardCollected: "on",
    });

    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).toContain(message);
    expect(JSON.stringify(state)).not.toContain("secret SQL");
    expect(JSON.stringify(state)).not.toContain(SESSION_ID);
  });

  it("uses one stable checkout key for an authoritative success and replay", async () => {
    const { client, rpc } = fakeClient({
      tables: publicStudentTable,
      rpc: checkoutRpcData(true),
    });

    const first = await executeCheckout(client, "staff-secret", "0427", KEY, {
      binNumber: "1",
      pantherCardCollected: "on",
    });
    const retry = await executeCheckout(client, "staff-secret", "0427", KEY, {
      binNumber: "1",
      pantherCardCollected: "on",
    });

    expect(first.status).toBe("success");
    expect(retry).toMatchObject({
      status: "success",
      result: { idempotentReplay: true },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe(KEY);
    expect(rpc.mock.calls[1][1].p_idempotency_key).toBe(KEY);
  });

  it("reports committed checkout success when the identity refresh fails", async () => {
    const { client } = fakeClient({
      tables: {
        students: {
          data: {
            full_name: "Jordan Panther",
            panther_id: "900123456",
            email: "private@example.edu",
            phone: "+14045550123",
          },
          error: { message: "raw SQL credentials detail" },
        },
      },
      rpc: checkoutRpcData(),
    });
    const state = await executeCheckout(client, "staff-secret", "0427", KEY, {
      binNumber: "1",
      pantherCardCollected: "on",
    });

    expect(state).toMatchObject({
      status: "success",
      result: { student: null, binNumber: "1" },
    });
    expect(JSON.stringify(state)).not.toContain("try again");
    expect(JSON.stringify(state)).not.toMatch(
      /private@example|credentials|phone/,
    );
  });

  it("refreshes eligible bins after an authoritative BIN_NOT_USABLE error", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const replacementBinId = "1d149423-eed2-4d40-b486-9399b17eb33d";
    const { client } = fakeClient({
      tables: {
        queue_entries: {
          data: {
            id: ENTRY_ID,
            student_id: STUDENT_ID,
            reserved_bin_id: BIN_ID,
            pickup_expires_at: future,
            status: "READY",
          },
          error: null,
        },
        reservations: {
          data: { bin_id: BIN_ID, status: "ACTIVE", expires_at: future },
          error: null,
        },
        students: publicStudentTable.students,
        bins: [
          {
            data: { id: BIN_ID, bin_number: "1", status: "RESERVED" },
            error: null,
          },
          {
            data: [
              {
                id: replacementBinId,
                bin_number: "12",
                status: "AVAILABLE",
              },
            ],
            error: null,
          },
        ],
      },
      rpc: {
        data: null,
        error: { message: "PANTHER_CARTS:BIN_NOT_USABLE" },
      },
    });

    const state = await executeCheckout(client, "staff-secret", "0427", KEY, {
      binNumber: "2",
      pantherCardCollected: "on",
    });

    expect(state).toMatchObject({
      status: "error",
      eligibleBins: [
        { binNumber: "1", reserved: true },
        { binNumber: "12", reserved: false },
      ],
    });
  });

  it("looks up a return by bin and creates a fresh UUID confirmation attempt", async () => {
    const { client } = fakeClient({
      tables: {
        bins: {
          data: { id: BIN_ID, bin_number: "014", status: "OUT" },
          error: null,
        },
        rentals: {
          data: { student_id: STUDENT_ID, status: "OUT" },
          error: null,
        },
        students: publicStudentTable.students,
      },
    });
    const state = await executeReturnLookup(client, "staff-secret", {
      binNumber: " 014 ",
    });

    expect(state).toMatchObject({
      status: "preview",
      values: { binNumber: "014" },
      preview: {
        student: { fullName: "Jordan Panther", pantherId: "900123456" },
        binNumber: "014",
      },
    });
    if (state.status === "preview") {
      expect(state.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("requires PantherCard return and preserves the physical bin number", async () => {
    const { client, rpc } = fakeClient();
    const state = await executeReturn(client, "staff-secret", KEY, {
      binNumber: "014",
      pantherCardReturned: null,
    });

    expect(state).toMatchObject({
      status: "error",
      values: { binNumber: "014", pantherCardReturned: false },
    });
    expect(JSON.stringify(state)).toContain("PantherCard");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["BIN_NOT_FOUND", "does not exist"],
    ["NO_ACTIVE_RENTAL", "no longer has an active rental"],
    ["PANTHERCARD_REQUIRED", "PantherCard"],
    ["IDEMPOTENCY_KEY_REQUIRED", "confirmation expired"],
    ["IDEMPOTENCY_CONFLICT", "already used"],
  ])("maps return %s to a safe workflow message", async (code, message) => {
    const { client } = fakeClient({
      rpc: {
        data: null,
        error: { message: `PANTHER_CARTS:${code} private database response` },
      },
    });
    const state = await executeReturn(client, "staff-secret", KEY, {
      binNumber: "1",
      pantherCardReturned: "on",
    });

    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).toContain(message);
    expect(JSON.stringify(state)).not.toContain("private database response");
  });

  it("uses one stable return key for a successful idempotent replay", async () => {
    const { client, rpc } = fakeClient({
      tables: publicStudentTable,
      rpc: returnRpcData(true),
    });

    const result = await executeReturn(client, "staff-secret", KEY, {
      binNumber: "1",
      pantherCardReturned: "on",
    });

    expect(result).toMatchObject({
      status: "success",
      result: {
        student: { fullName: "Jordan Panther", pantherId: "900123456" },
        binNumber: "1",
        idempotentReplay: true,
      },
    });
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe(KEY);
  });

  it("reports committed return success when the identity refresh fails", async () => {
    const { client } = fakeClient({
      tables: {
        students: {
          data: null,
          error: { message: "transient read failure with private detail" },
        },
      },
      rpc: returnRpcData(),
    });

    const state = await executeReturn(client, "staff-secret", KEY, {
      binNumber: "1",
      pantherCardReturned: "on",
    });

    expect(state).toMatchObject({
      status: "success",
      result: { student: null, binNumber: "1" },
    });
    expect(JSON.stringify(state)).not.toMatch(/try again|private detail/);
  });

  it("maps unexpected return failures without exposing raw database text", async () => {
    const { client } = fakeClient({
      rpc: {
        data: null,
        error: { message: "duplicate key rentals private raw response" },
      },
    });
    const state = await executeReturn(client, "staff-secret", KEY, {
      binNumber: "1",
      pantherCardReturned: "on",
    });

    expect(JSON.stringify(state)).toContain("try again");
    expect(JSON.stringify(state)).not.toContain("private raw response");
  });
});
