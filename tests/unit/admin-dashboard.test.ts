import { describe, expect, it, vi } from "vitest";
import {
  executeAddAdminBins,
  executeConfigureAdminSession,
  executeCreateAdminSession,
  executeEndAdminSession,
  executeNotifyAdminRental,
  executeStartAdminSession,
  getAdminDashboardSnapshot,
  type AdminDatabaseClient,
} from "@/lib/admin/dashboard";
import { ADMIN_VIEW_OPTIONS, classifyRentalStatus } from "@/lib/admin/types";

process.env.PANTHER_AUTH_SECRET =
  "unit-test-auth-secret-at-least-32-characters";

const SESSION_ID = "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9";
const RENTAL_ID = "81bbf354-a557-4d22-9da0-6574416c62f1";
const KEY = "7b830507-034f-4746-9a67-f7e9184d40bc";
const NOW = "2026-08-11T15:00:00.000Z";

type Response = { data: unknown; error: { message: string } | null };
type Builder = Record<string, ReturnType<typeof vi.fn>>;

function query(response: Response) {
  const builder: Builder = {};
  builder.select = vi.fn(() => builder);
  builder.in = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.range = vi.fn().mockResolvedValue(response);
  builder.limit = vi.fn((value: number) =>
    value === 1 ? builder : Promise.resolve(response),
  );
  builder.maybeSingle = vi.fn().mockResolvedValue(response);
  return builder;
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    name: "Fall service",
    status: "ACTIVE",
    student_code: "signup-code",
    staff_code: "staff-code",
    staff_access_code_ciphertext: null,
    staff_credential_version: "legacy-sha256",
    rental_duration_minutes: 60,
    pickup_window_minutes: 10,
    created_at: NOW,
    started_at: NOW,
    ended_at: null,
    ...overrides,
  };
}

function fakeClient(
  responses: Record<string, Response>,
  rpcResponse: Response = { data: null, error: null },
) {
  const builders = Object.fromEntries(
    Object.entries(responses).map(([name, response]) => [
      name,
      query(response),
    ]),
  ) as Record<string, Builder>;
  const from = vi.fn((name: string) => builders[name]);
  const rpc = vi.fn().mockResolvedValue(rpcResponse);
  return {
    client: { from, rpc } as unknown as AdminDatabaseClient,
    builders,
    rpc,
  };
}

function emptyDashboardClient() {
  return fakeClient({
    sessions: { data: sessionRow(), error: null },
    v_current_out_rentals: { data: [], error: null },
    v_current_late_rentals: { data: [], error: null },
    v_all_late_rentals: { data: [], error: null },
    v_inventory: { data: [], error: null },
    v_session_rentals: { data: [], error: null },
    v_current_waitlist: { data: [], error: null },
  });
}

function statusAwareClient(
  sessions: Array<ReturnType<typeof sessionRow>>,
  rpcResponse: Response = { data: null, error: null },
) {
  const base = emptyDashboardClient();
  const sessionBuilders: Builder[] = [];
  const from = vi.fn((name: string) => {
    if (name !== "sessions") return base.builders[name];

    let selectedStatus: unknown;
    const builder = query({ data: null, error: null });
    builder.eq.mockImplementation((column: string, value: unknown) => {
      if (column === "status") selectedStatus = value;
      return builder;
    });
    builder.maybeSingle.mockImplementation(async () => ({
      data:
        sessions.find((session) => session.status === selectedStatus) ?? null,
      error: null,
    }));
    sessionBuilders.push(builder);
    return builder;
  });
  const rpc = vi.fn().mockResolvedValue(rpcResponse);
  return {
    client: { from, rpc } as unknown as AdminDatabaseClient,
    builders: base.builders,
    from,
    rpc,
    sessionBuilders,
  };
}

describe("admin dashboard data layer", () => {
  it("defines exactly the seven product views", () => {
    expect(ADMIN_VIEW_OPTIONS.map(([, label]) => label)).toEqual([
      "Overview",
      "Current late rentals",
      "All late rentals in the session, including returned rentals",
      "Currently checked out",
      "Total inventory",
      "All rentals in the session",
      "Current waitlist",
    ]);
  });

  it("puts an exact session_id constraint on every admin reporting read", async () => {
    const { client, builders } = emptyDashboardClient();
    await getAdminDashboardSnapshot(client);
    const contracts = {
      v_current_out_rentals:
        "rental_id,session_id,bin_number,full_name,panther_id,email,phone,checked_out_at,due_at,is_currently_late",
      v_current_late_rentals:
        "rental_id,session_id,bin_number,full_name,panther_id,email,phone,checked_out_at,due_at",
      v_all_late_rentals:
        "rental_id,session_id,bin_number,full_name,panther_id,email,phone,status,checked_out_at,due_at,returned_at,was_late,is_currently_late",
      v_inventory:
        "session_id,bin_number,status,current_rental_id,current_checked_out_at,current_due_at,is_currently_late,current_full_name,current_panther_id,current_email,current_phone",
      v_session_rentals:
        "rental_id,session_id,bin_number,full_name,panther_id,email,phone,status,checked_out_at,due_at,returned_at,was_late,is_currently_late",
      v_current_waitlist:
        "queue_entry_id,session_id,queue_rank,joined_at,phone,full_name,panther_id,email",
    } as const;
    for (const [table, projection] of Object.entries(contracts)) {
      expect(builders[table].select).toHaveBeenCalledWith(projection);
      expect(builders[table].eq.mock.calls).toContainEqual([
        "session_id",
        SESSION_ID,
      ]);
      expect(builders[table].range).toHaveBeenCalledWith(0, 999);
    }
  });

  it("returns an empty, safe snapshot when the current session has no records", async () => {
    const { client } = emptyDashboardClient();
    const snapshot = await getAdminDashboardSnapshot(client);
    expect(snapshot.overview).toEqual({
      totalBins: 0,
      availableBins: 0,
      reservedBins: 0,
      checkedOutBins: 0,
      currentLateRentals: 0,
      currentWaitlist: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain(SESSION_ID);
    expect(snapshot.session).toMatchObject({
      studentCode: "signup-code",
      staffAccessCode: null,
      studentLink: "/student/signup-code",
      staffLink: null,
      status: "ACTIVE",
    });
  });

  it("returns the no-session snapshot without querying reporting views", async () => {
    const fake = statusAwareClient([]);
    const result = await getAdminDashboardSnapshot(fake.client);
    expect(result.session).toBeNull();
    expect(result.overview.totalBins).toBe(0);
    expect(fake.from.mock.calls.map(([name]) => name)).toEqual([
      "sessions",
      "sessions",
      "sessions",
    ]);
  });

  it("falls back to the latest closed session", async () => {
    const closed = sessionRow({
      name: "Closed service",
      status: "CLOSED",
      ended_at: NOW,
    });
    const result = await getAdminDashboardSnapshot(
      statusAwareClient([closed]).client,
    );
    expect(result.session).toMatchObject({
      name: "Closed service",
      status: "CLOSED",
      endedAt: NOW,
    });
  });

  it("explicitly prefers an ACTIVE session when ACTIVE and DRAFT rows coexist", async () => {
    const active = sessionRow({ name: "Live session", status: "ACTIVE" });
    const draft = sessionRow({
      id: "15f7d61c-a959-447c-bb3f-da59561b90a2",
      name: "Stale draft",
      status: "DRAFT",
      started_at: null,
    });
    const fake = statusAwareClient([draft, active]);
    const result = await getAdminDashboardSnapshot(fake.client);
    expect(result.session).toMatchObject({
      name: "Live session",
      status: "ACTIVE",
    });
    expect(fake.sessionBuilders[0].eq).toHaveBeenCalledWith("status", "ACTIVE");
  });

  it("validates session creation while leaving access-code generation to PostgreSQL", async () => {
    const response = {
      session: {
        ...sessionRow(),
        status: "DRAFT",
        student_code: "signup-generated",
        staff_code: "staff-generated",
        staff_access_code_ciphertext: null,
        staff_credential_version: "legacy-sha256",
        started_at: null,
      },
      idempotent_replay: false,
    };
    const fake = fakeClient({}, { data: response, error: null });
    const result = await executeCreateAdminSession(fake.client, {
      name: "Fall service",
      rentalDurationMinutes: "60",
      pickupWindowMinutes: "10",
      idempotencyKey: KEY,
    });
    expect(result).toMatchObject({ status: "success" });
    const args = fake.rpc.mock.calls[0][1];
    expect(fake.rpc.mock.calls[0][0]).toBe("admin_create_session");
    expect(args).toMatchObject({
      p_name: "Fall service",
      p_rental_duration_minutes: 60,
      p_pickup_window_minutes: 10,
      p_idempotency_key: KEY,
    });
    expect(args.p_student_code).toMatch(/^signup-[a-f0-9]{32}$/);
    expect(args.p_staff_link_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(args.p_staff_access_code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(args.p_staff_link_ciphertext).not.toMatch(/staff-[a-f0-9]{32}/);

    const invalid = await executeCreateAdminSession(fake.client, {
      name: "",
      rentalDurationMinutes: "0",
      pickupWindowMinutes: "10",
      idempotencyKey: KEY,
    });
    expect(invalid.status).toBe("error");
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("maps the one-open-session invariant to a clean admin message", async () => {
    const fake = fakeClient(
      {},
      {
        data: null,
        error: {
          message:
            "PANTHER_CARTS:SESSION_ALREADY_OPEN duplicate key internal detail",
        },
      },
    );
    const result = await executeCreateAdminSession(fake.client, {
      name: "Second browser tab",
      rentalDurationMinutes: "60",
      pickupWindowMinutes: "10",
      idempotencyKey: KEY,
    });
    expect(result).toEqual({
      status: "error",
      message:
        "A draft or active session already exists. Use or end that session before creating another.",
      fieldErrors: {},
    });
    expect(JSON.stringify(result)).not.toMatch(/duplicate key|internal detail/);
  });

  it("authoritatively resolves lifecycle/configuration mutations without a client session ID", async () => {
    const rpcResponse = {
      data: { session: sessionRow(), idempotent_replay: false },
      error: null,
    };
    const configure = fakeClient(
      { sessions: { data: sessionRow(), error: null } },
      rpcResponse,
    );
    await executeConfigureAdminSession(configure.client, {
      rentalDurationMinutes: "90",
      pickupWindowMinutes: "15",
      sessionId: "clientSessionId",
    });
    expect(configure.rpc).toHaveBeenCalledWith("admin_configure_session", {
      p_session_id: SESSION_ID,
      p_rental_duration_minutes: 90,
      p_pickup_window_minutes: 15,
    });

    for (const [execute, rpcName] of [
      [executeStartAdminSession, "admin_start_session"],
      [executeEndAdminSession, "admin_end_session"],
    ] as const) {
      const fake = fakeClient(
        { sessions: { data: sessionRow(), error: null } },
        rpcResponse,
      );
      await execute(fake.client);
      expect(fake.rpc).toHaveBeenCalledWith(rpcName, {
        p_session_id: SESSION_ID,
      });
      expect(JSON.stringify(fake.rpc.mock.calls)).not.toContain(
        "clientSessionId",
      );
    }
  });

  it("rejects foreign-session rows from every reporting mapper", async () => {
    const foreignSessionId = "15f7d61c-a959-447c-bb3f-da59561b90a2";
    const contact = {
      session_id: foreignSessionId,
      full_name: "Jordan Panther",
      panther_id: "900123456",
      email: "jordan@example.edu",
      phone: "+14045550123",
    };
    const cases = [
      [
        "v_current_out_rentals",
        {
          ...contact,
          rental_id: RENTAL_ID,
          bin_number: "1",
          checked_out_at: NOW,
          due_at: "2026-08-11T16:00:00.000Z",
          is_currently_late: false,
        },
      ],
      [
        "v_current_late_rentals",
        {
          ...contact,
          rental_id: RENTAL_ID,
          bin_number: "1",
          checked_out_at: NOW,
          due_at: "2026-08-11T14:00:00.000Z",
        },
      ],
      ...["v_all_late_rentals", "v_session_rentals"].map((table) => [
        table,
        {
          ...contact,
          rental_id: RENTAL_ID,
          bin_number: "1",
          status: "OUT",
          checked_out_at: NOW,
          due_at: "2026-08-11T14:00:00.000Z",
          returned_at: null,
          was_late: false,
          is_currently_late: true,
        },
      ]),
      [
        "v_inventory",
        {
          session_id: foreignSessionId,
          bin_number: "1",
          status: "AVAILABLE",
          current_rental_id: null,
          current_checked_out_at: null,
          current_due_at: null,
          is_currently_late: false,
          current_full_name: null,
          current_panther_id: null,
          current_email: null,
          current_phone: null,
        },
      ],
      [
        "v_current_waitlist",
        {
          ...contact,
          queue_entry_id: "42aa10ce-237f-45c7-9345-29466cb33dbc",
          queue_rank: 1,
          joined_at: NOW,
        },
      ],
    ] as Array<[string, Record<string, unknown>]>;

    for (const [table, row] of cases) {
      const fake = emptyDashboardClient();
      fake.builders[table].range.mockResolvedValue({
        data: [row],
        error: null,
      });
      await expect(getAdminDashboardSnapshot(fake.client)).rejects.toThrow(
        /Queue operation failed/,
      );
    }
  });

  it("sorts inventory by numeric bin number for display", async () => {
    const fake = emptyDashboardClient();
    fake.builders.v_inventory.range.mockResolvedValue({
      data: ["10", "2"].map((binNumber) => ({
        session_id: SESSION_ID,
        bin_number: binNumber,
        status: "AVAILABLE",
        current_rental_id: null,
        current_checked_out_at: null,
        current_due_at: null,
        is_currently_late: false,
        current_full_name: null,
        current_panther_id: null,
        current_email: null,
        current_phone: null,
      })),
      error: null,
    });
    const result = await getAdminDashboardSnapshot(fake.client);
    expect(result.inventory.map((row) => row.binNumber)).toEqual(["2", "10"]);
  });

  it("projects required student details while stripping internal session fields", async () => {
    const fake = emptyDashboardClient();
    fake.builders.v_current_out_rentals.range.mockResolvedValue({
      data: [
        {
          rental_id: RENTAL_ID,
          session_id: SESSION_ID,
          bin_number: "1",
          full_name: "Jordan Panther",
          panther_id: "900123456",
          email: "jordan@example.edu",
          phone: "+14045550123",
          checked_out_at: NOW,
          due_at: "2026-08-11T16:00:00.000Z",
          is_currently_late: false,
          service_role_key: "must-not-project",
        },
      ],
      error: null,
    });
    const result = await getAdminDashboardSnapshot(fake.client);
    expect(result.currentOutRentals[0]).toMatchObject({
      fullName: "Jordan Panther",
      pantherId: "900123456",
      email: "jordan@example.edu",
      phone: "+14045550123",
      statusText: "Checked out — on time",
    });
    expect(JSON.stringify(result.currentOutRentals)).not.toMatch(
      /session_id|service_role|must-not-project/,
    );
    expect(fake.builders.v_current_out_rentals.select.mock.calls[0][0]).toBe(
      "rental_id,session_id,bin_number,full_name,panther_id,email,phone,checked_out_at,due_at,is_currently_late",
    );
  });

  it("classifies every specified rental status with readable text", () => {
    expect(
      classifyRentalStatus({
        rentalStatus: "OUT",
        isCurrentlyLate: true,
        wasLate: false,
      }),
    ).toEqual({
      visualStatus: "currently-late",
      statusText: "Checked out — late",
    });
    expect(
      classifyRentalStatus({
        rentalStatus: "OUT",
        isCurrentlyLate: false,
        wasLate: false,
      }).visualStatus,
    ).toBe("checked-out-on-time");
    expect(
      classifyRentalStatus({
        rentalStatus: "RETURNED",
        isCurrentlyLate: false,
        wasLate: true,
      }).visualStatus,
    ).toBe("returned-late");
    expect(
      classifyRentalStatus({
        rentalStatus: "RETURNED",
        isCurrentlyLate: false,
        wasLate: false,
      }).visualStatus,
    ).toBe("returned-on-time");
  });

  it("resolves the current session server-side for bin mutations and reports duplicates", async () => {
    const fake = fakeClient(
      { sessions: { data: sessionRow(), error: null } },
      { data: { added: ["2"], duplicates: ["1"] }, error: null },
    );
    const result = await executeAddAdminBins(fake.client, {
      mode: "paste",
      pastedBins: "001, 1, 2",
    });
    expect(fake.rpc).toHaveBeenCalledWith("admin_add_bins", {
      p_session_id: SESSION_ID,
      p_bin_numbers: ["1", "2"],
    });
    expect(result).toMatchObject({
      status: "success",
      addedBins: ["2"],
      duplicateBins: ["1"],
    });
    expect(JSON.stringify(fake.rpc.mock.calls)).not.toContain(
      "clientSessionId",
    );
  });

  it("enqueues Notify through the Ticket 4 RPC without returning outbox internals", async () => {
    const fake = fakeClient(
      { sessions: { data: sessionRow(), error: null } },
      {
        data: {
          outbox_id: "42aa10ce-237f-45c7-9345-29466cb33dbc",
          body: "Panther Carts: Bin 1 has 12 minutes remaining in the rental.",
          idempotent_replay: false,
        },
        error: null,
      },
    );
    const result = await executeNotifyAdminRental(fake.client, {
      rentalId: RENTAL_ID,
      idempotencyKey: KEY,
    });
    expect(fake.rpc).toHaveBeenCalledWith("admin_notify_rental", {
      p_session_id: SESSION_ID,
      p_rental_id: RENTAL_ID,
      p_idempotency_key: KEY,
    });
    expect(result).toEqual({
      status: "success",
      message: "Rental-time notification queued for SMS delivery.",
      idempotentReplay: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/outbox_id|body|provider/i);
  });

  it("notifies an outstanding rental from the closed session displayed by the dashboard", async () => {
    const closed = sessionRow({
      status: "CLOSED",
      ended_at: NOW,
    });
    const fake = statusAwareClient([closed], {
      data: {
        outbox_id: "42aa10ce-237f-45c7-9345-29466cb33dbc",
        body: "Panther Carts: Bin 1 is 12 minutes overdue.",
        idempotent_replay: false,
      },
      error: null,
    });
    const result = await executeNotifyAdminRental(fake.client, {
      rentalId: RENTAL_ID,
      idempotencyKey: KEY,
    });
    expect(fake.rpc).toHaveBeenCalledWith("admin_notify_rental", {
      p_session_id: SESSION_ID,
      p_rental_id: RENTAL_ID,
      p_idempotency_key: KEY,
    });
    expect(result.status).toBe("success");
    expect(
      fake.sessionBuilders.map((builder) => builder.eq.mock.calls[0]),
    ).toEqual([
      ["status", "ACTIVE"],
      ["status", "DRAFT"],
      ["status", "CLOSED"],
    ]);
  });

  it("maps raw RPC failures to safe messages", async () => {
    const fake = fakeClient(
      { sessions: { data: sessionRow(), error: null } },
      {
        data: null,
        error: { message: "duplicate key raw SQL secret detail" },
      },
    );
    const result = await executeNotifyAdminRental(fake.client, {
      rentalId: RENTAL_ID,
      idempotencyKey: KEY,
    });
    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toMatch(
      /duplicate key|SQL|secret detail/,
    );
  });
});
