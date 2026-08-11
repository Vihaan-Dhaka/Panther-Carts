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

function sessionRow() {
  return {
    id: SESSION_ID,
    name: "Fall service",
    status: "ACTIVE",
    student_code: "signup-code",
    staff_code: "staff-code",
    rental_duration_minutes: 60,
    pickup_window_minutes: 10,
    created_at: NOW,
    started_at: NOW,
    ended_at: null,
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
      staffCode: "staff-code",
      studentLink: "/student/signup-code",
      staffLink: "/staff/staff-code",
      status: "ACTIVE",
    });
  });

  it("validates session creation and generates stable student/staff codes", async () => {
    const response = {
      session: {
        ...sessionRow(),
        status: "DRAFT",
        student_code: "signup-generated",
        staff_code: "staff-generated",
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
    expect(args.p_student_code).toMatch(/^signup-[A-Za-z0-9_-]{16}$/);
    expect(args.p_staff_code).toMatch(/^staff-[A-Za-z0-9_-]{16}$/);

    const invalid = await executeCreateAdminSession(fake.client, {
      name: "",
      rentalDurationMinutes: "0",
      pickupWindowMinutes: "10",
      idempotencyKey: KEY,
    });
    expect(invalid.status).toBe("error");
    expect(fake.rpc).toHaveBeenCalledTimes(1);
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

  it("rejects a reporting row returned from another session", async () => {
    const fake = emptyDashboardClient();
    fake.builders.v_current_out_rentals.range.mockResolvedValue({
      data: [
        {
          rental_id: RENTAL_ID,
          session_id: "15f7d61c-a959-447c-bb3f-da59561b90a2",
          bin_number: "1",
          full_name: "Jordan Panther",
          panther_id: "900123456",
          email: "jordan@example.edu",
          phone: "+14045550123",
          checked_out_at: NOW,
          due_at: "2026-08-11T16:00:00.000Z",
          is_currently_late: false,
        },
      ],
      error: null,
    });
    await expect(getAdminDashboardSnapshot(fake.client)).rejects.toThrow(
      /Queue operation failed/,
    );
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
      message: "Rental-time notification queued for Ticket 5 delivery.",
      idempotentReplay: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/outbox_id|body|provider/i);
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
