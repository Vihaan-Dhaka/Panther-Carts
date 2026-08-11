import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  type AdminActionResult,
  type AdminDashboardSnapshot,
  type AdminInventoryRow,
  type AdminRentalRow,
  type AdminSessionDto,
  type AdminWaitlistRow,
  classifyRentalStatus,
} from "@/lib/admin/types";
import {
  QueueErrorCode,
  QueueOperationError,
  parseQueueErrorCode,
} from "@/lib/queue/errors";
import {
  adminBinMutationSchema,
  adminBinsRpcResponseSchema,
  adminNotifyRpcResponseSchema,
  adminNotifySchema,
  adminSessionConfigurationSchema,
  adminSessionCreationSchema,
  adminSessionRowSchema,
  adminSessionRpcResponseSchema,
  currentLateRentalRowSchema,
  currentOutRentalRowSchema,
  historicalRentalRowSchema,
  inventoryRowSchema,
  waitlistRowSchema,
} from "@/lib/validation/admin";

export type AdminDatabaseClient = Pick<SupabaseClient, "from" | "rpc">;

const SESSION_SELECT =
  "id,name,status,student_code,staff_code,rental_duration_minutes,pickup_window_minutes,created_at,started_at,ended_at";
const CURRENT_OUT_SELECT =
  "rental_id,session_id,bin_number,full_name,panther_id,email,phone,checked_out_at,due_at,is_currently_late";
const CURRENT_LATE_SELECT =
  "rental_id,session_id,bin_number,full_name,panther_id,email,phone,checked_out_at,due_at";
const HISTORICAL_RENTAL_SELECT =
  "rental_id,session_id,bin_number,full_name,panther_id,email,phone,status,checked_out_at,due_at,returned_at,was_late,is_currently_late";
const INVENTORY_SELECT =
  "session_id,bin_number,status,current_rental_id,current_checked_out_at,current_due_at,is_currently_late,current_full_name,current_panther_id,current_email,current_phone";
const WAITLIST_SELECT =
  "queue_entry_id,session_id,queue_rank,joined_at,phone,full_name,panther_id,email";
const ADMIN_PAGE_SIZE = 1_000;

type AdminSessionRow = z.infer<typeof adminSessionRowSchema>;

function databaseFailure(): QueueOperationError {
  return new QueueOperationError(null);
}

function actionError(error: unknown): AdminActionResult {
  const operationError =
    error instanceof QueueOperationError ? error : databaseFailure();
  switch (operationError.code) {
    case QueueErrorCode.SESSION_NOT_FOUND:
      return {
        status: "error",
        message:
          "No current session was found. Refresh the dashboard and try again.",
        fieldErrors: {},
      };
    case QueueErrorCode.SESSION_NOT_DRAFT:
      return {
        status: "error",
        message: "Only a draft session can be started.",
        fieldErrors: {},
      };
    case QueueErrorCode.SESSION_NOT_ACTIVE:
      return {
        status: "error",
        message: "Only an active session can be ended.",
        fieldErrors: {},
      };
    case QueueErrorCode.SESSION_CLOSED:
      return {
        status: "error",
        message: "That session is closed and can no longer be changed.",
        fieldErrors: {},
      };
    case QueueErrorCode.SESSION_ALREADY_OPEN:
      return {
        status: "error",
        message:
          "A draft or active session already exists. Use or end that session before creating another.",
        fieldErrors: {},
      };
    case QueueErrorCode.NO_ACTIVE_RENTAL:
      return {
        status: "error",
        message: "That rental is no longer active. Refresh the dashboard.",
        fieldErrors: {},
      };
    case QueueErrorCode.IDEMPOTENCY_CONFLICT:
      return {
        status: "error",
        message:
          "This request was already used for a different operation. Refresh and try again.",
        fieldErrors: {},
      };
    default:
      return {
        status: "error",
        message: "We could not complete that admin action. Please try again.",
        fieldErrors: {},
      };
  }
}

function validationError(error: z.ZodError): AdminActionResult {
  return {
    status: "error",
    message: null,
    fieldErrors: error.flatten().fieldErrors,
  };
}

async function openSessionQuery(
  client: AdminDatabaseClient,
): Promise<AdminSessionRow | null> {
  // Keep legacy/pre-dashboard sessions visible. The one-open invariant applies
  // to the production admin creation path, but reads still support existing
  // sessions that predate its idempotency metadata.
  const active = await sessionByStatus(client, "ACTIVE");
  if (active) return active;
  return sessionByStatus(client, "DRAFT");
}

async function sessionByStatus(
  client: AdminDatabaseClient,
  status: "ACTIVE" | "DRAFT",
): Promise<AdminSessionRow | null> {
  const { data, error } = await client
    .from("sessions")
    .select(SESSION_SELECT)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw databaseFailure();
  if (data === null) return null;
  const parsed = adminSessionRowSchema.safeParse(data);
  if (!parsed.success) throw databaseFailure();
  return parsed.data;
}

async function currentSessionQuery(
  client: AdminDatabaseClient,
): Promise<AdminSessionRow | null> {
  const open = await openSessionQuery(client);
  if (open) return open;

  const { data, error } = await client
    .from("sessions")
    .select(SESSION_SELECT)
    .eq("status", "CLOSED")
    .order("ended_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw databaseFailure();
  if (data === null) return null;
  const parsed = adminSessionRowSchema.safeParse(data);
  if (!parsed.success) throw databaseFailure();
  return parsed.data;
}

async function requireOpenSession(
  client: AdminDatabaseClient,
): Promise<AdminSessionRow> {
  const session = await openSessionQuery(client);
  if (!session) throw new QueueOperationError(QueueErrorCode.SESSION_NOT_FOUND);
  return session;
}

async function requireDisplayedSession(
  client: AdminDatabaseClient,
): Promise<AdminSessionRow> {
  const session = await currentSessionQuery(client);
  if (!session) throw new QueueOperationError(QueueErrorCode.SESSION_NOT_FOUND);
  return session;
}

function safeBaseUrl(): string {
  const input = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sessionDto(row: AdminSessionRow): AdminSessionDto {
  const baseUrl = safeBaseUrl();
  const studentPath = `/student/${encodeURIComponent(row.student_code)}`;
  const staffPath = `/staff/${encodeURIComponent(row.staff_code)}`;
  return {
    name: row.name,
    status: row.status,
    studentCode: row.student_code,
    staffCode: row.staff_code,
    studentLink: `${baseUrl}${studentPath}`,
    staffLink: `${baseUrl}${staffPath}`,
    rentalDurationMinutes: row.rental_duration_minutes,
    pickupWindowMinutes: row.pickup_window_minutes,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function assertSession(rowSessionId: string, expectedSessionId: string): void {
  if (rowSessionId !== expectedSessionId) throw databaseFailure();
}

function currentOutDto(
  row: z.infer<typeof currentOutRentalRowSchema>,
  sessionId: string,
): AdminRentalRow {
  assertSession(row.session_id, sessionId);
  const classification = classifyRentalStatus({
    rentalStatus: "OUT",
    isCurrentlyLate: row.is_currently_late,
    wasLate: false,
  });
  return {
    rentalId: row.rental_id,
    binNumber: row.bin_number,
    fullName: row.full_name,
    pantherId: row.panther_id,
    email: row.email,
    phone: row.phone,
    rentalStatus: "OUT",
    checkedOutAt: row.checked_out_at,
    dueAt: row.due_at,
    returnedAt: null,
    wasLate: false,
    isCurrentlyLate: row.is_currently_late,
    ...classification,
  };
}

function currentLateDto(
  row: z.infer<typeof currentLateRentalRowSchema>,
  sessionId: string,
): AdminRentalRow {
  assertSession(row.session_id, sessionId);
  return {
    rentalId: row.rental_id,
    binNumber: row.bin_number,
    fullName: row.full_name,
    pantherId: row.panther_id,
    email: row.email,
    phone: row.phone,
    rentalStatus: "OUT",
    checkedOutAt: row.checked_out_at,
    dueAt: row.due_at,
    returnedAt: null,
    wasLate: false,
    isCurrentlyLate: true,
    visualStatus: "currently-late",
    statusText: "Checked out — late",
  };
}

function historicalDto(
  row: z.infer<typeof historicalRentalRowSchema>,
  sessionId: string,
): AdminRentalRow {
  assertSession(row.session_id, sessionId);
  return {
    rentalId: row.rental_id,
    binNumber: row.bin_number,
    fullName: row.full_name,
    pantherId: row.panther_id,
    email: row.email,
    phone: row.phone,
    rentalStatus: row.status,
    checkedOutAt: row.checked_out_at,
    dueAt: row.due_at,
    returnedAt: row.returned_at,
    wasLate: row.was_late,
    isCurrentlyLate: row.is_currently_late,
    ...classifyRentalStatus({
      rentalStatus: row.status,
      isCurrentlyLate: row.is_currently_late,
      wasLate: row.was_late,
    }),
  };
}

function inventoryDto(
  row: z.infer<typeof inventoryRowSchema>,
  sessionId: string,
): AdminInventoryRow {
  assertSession(row.session_id, sessionId);
  if (row.status === "OUT") {
    if (
      !row.current_rental_id ||
      !row.current_checked_out_at ||
      !row.current_due_at ||
      !row.current_full_name ||
      !row.current_panther_id ||
      !row.current_email ||
      !row.current_phone
    ) {
      throw databaseFailure();
    }
    const classification = classifyRentalStatus({
      rentalStatus: "OUT",
      isCurrentlyLate: row.is_currently_late,
      wasLate: false,
    });
    return {
      binNumber: row.bin_number,
      binStatus: row.status,
      currentRentalId: row.current_rental_id,
      currentCheckedOutAt: row.current_checked_out_at,
      currentDueAt: row.current_due_at,
      isCurrentlyLate: row.is_currently_late,
      fullName: row.current_full_name,
      pantherId: row.current_panther_id,
      email: row.current_email,
      phone: row.current_phone,
      ...classification,
    };
  }

  return {
    binNumber: row.bin_number,
    binStatus: row.status,
    currentRentalId: null,
    currentCheckedOutAt: null,
    currentDueAt: null,
    isCurrentlyLate: false,
    fullName: null,
    pantherId: null,
    email: null,
    phone: null,
    visualStatus: row.status === "AVAILABLE" ? "available" : "reserved",
    statusText:
      row.status === "AVAILABLE" ? "Available" : "Reserved — awaiting pickup",
  };
}

async function queryRows(
  client: AdminDatabaseClient,
  table: string,
  select: string,
  sessionId: string,
  orderColumn: string,
  ascending: boolean,
  tieBreaker: string,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 0; ; page += 1) {
    const from = page * ADMIN_PAGE_SIZE;
    const { data, error } = await client
      .from(table)
      .select(select)
      .eq("session_id", sessionId)
      .order(orderColumn, { ascending })
      .order(tieBreaker, { ascending: true })
      .range(from, from + ADMIN_PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) throw databaseFailure();
    rows.push(...data);
    if (data.length < ADMIN_PAGE_SIZE) return rows;
  }
}

export async function getAdminDashboardSnapshot(
  client: AdminDatabaseClient,
): Promise<AdminDashboardSnapshot> {
  const session = await currentSessionQuery(client);
  const empty: AdminDashboardSnapshot = {
    session: session ? sessionDto(session) : null,
    overview: {
      totalBins: 0,
      availableBins: 0,
      reservedBins: 0,
      checkedOutBins: 0,
      currentLateRentals: 0,
      currentWaitlist: 0,
    },
    currentLateRentals: [],
    allLateRentals: [],
    currentOutRentals: [],
    inventory: [],
    sessionRentals: [],
    waitlist: [],
  };
  if (!session) return empty;

  const [
    currentOutData,
    currentLateData,
    allLateData,
    inventoryData,
    rentalsData,
    waitlistData,
  ] = await Promise.all([
    queryRows(
      client,
      "v_current_out_rentals",
      CURRENT_OUT_SELECT,
      session.id,
      "due_at",
      true,
      "rental_id",
    ),
    queryRows(
      client,
      "v_current_late_rentals",
      CURRENT_LATE_SELECT,
      session.id,
      "due_at",
      true,
      "rental_id",
    ),
    queryRows(
      client,
      "v_all_late_rentals",
      HISTORICAL_RENTAL_SELECT,
      session.id,
      "due_at",
      false,
      "rental_id",
    ),
    queryRows(
      client,
      "v_inventory",
      INVENTORY_SELECT,
      session.id,
      "bin_number",
      true,
      "bin_number",
    ),
    queryRows(
      client,
      "v_session_rentals",
      HISTORICAL_RENTAL_SELECT,
      session.id,
      "checked_out_at",
      false,
      "rental_id",
    ),
    queryRows(
      client,
      "v_current_waitlist",
      WAITLIST_SELECT,
      session.id,
      "queue_rank",
      true,
      "queue_entry_id",
    ),
  ]);

  const currentOutParsed = z
    .array(currentOutRentalRowSchema)
    .safeParse(currentOutData);
  const currentLateParsed = z
    .array(currentLateRentalRowSchema)
    .safeParse(currentLateData);
  const allLateParsed = z
    .array(historicalRentalRowSchema)
    .safeParse(allLateData);
  const inventoryParsed = z.array(inventoryRowSchema).safeParse(inventoryData);
  const rentalsParsed = z
    .array(historicalRentalRowSchema)
    .safeParse(rentalsData);
  const waitlistParsed = z.array(waitlistRowSchema).safeParse(waitlistData);
  if (
    !currentOutParsed.success ||
    !currentLateParsed.success ||
    !allLateParsed.success ||
    !inventoryParsed.success ||
    !rentalsParsed.success ||
    !waitlistParsed.success
  ) {
    throw databaseFailure();
  }

  const currentOutRentals = currentOutParsed.data.map((row) =>
    currentOutDto(row, session.id),
  );
  const currentLateRentals = currentLateParsed.data.map((row) =>
    currentLateDto(row, session.id),
  );
  const allLateRentals = allLateParsed.data.map((row) =>
    historicalDto(row, session.id),
  );
  const inventory = inventoryParsed.data
    .map((row) => inventoryDto(row, session.id))
    .sort((left, right) => Number(left.binNumber) - Number(right.binNumber));
  const sessionRentals = rentalsParsed.data.map((row) =>
    historicalDto(row, session.id),
  );
  const waitlist: AdminWaitlistRow[] = waitlistParsed.data.map((row) => {
    assertSession(row.session_id, session.id);
    return {
      queueEntryId: row.queue_entry_id,
      position: row.queue_rank,
      joinedAt: row.joined_at,
      fullName: row.full_name,
      pantherId: row.panther_id,
      email: row.email,
      phone: row.phone,
    };
  });

  return {
    session: sessionDto(session),
    overview: {
      totalBins: inventory.length,
      availableBins: inventory.filter((row) => row.binStatus === "AVAILABLE")
        .length,
      reservedBins: inventory.filter((row) => row.binStatus === "RESERVED")
        .length,
      checkedOutBins: inventory.filter((row) => row.binStatus === "OUT").length,
      currentLateRentals: currentLateRentals.length,
      currentWaitlist: waitlist.length,
    },
    currentLateRentals,
    allLateRentals,
    currentOutRentals,
    inventory,
    sessionRentals,
    waitlist,
  };
}

async function sessionRpc(
  client: AdminDatabaseClient,
  name: string,
  args: Record<string, unknown>,
  expectedSessionId?: string,
) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new QueueOperationError(parseQueueErrorCode(error.message));
  const parsed = adminSessionRpcResponseSchema.safeParse(data);
  if (!parsed.success) throw databaseFailure();
  if (expectedSessionId && parsed.data.session.id !== expectedSessionId) {
    throw databaseFailure();
  }
  return parsed.data;
}

export async function executeCreateAdminSession(
  client: AdminDatabaseClient,
  input: Record<string, unknown>,
): Promise<AdminActionResult> {
  const parsed = adminSessionCreationSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const result = await sessionRpc(client, "admin_create_session", {
      p_name: parsed.data.name,
      p_rental_duration_minutes: parsed.data.rentalDurationMinutes,
      p_pickup_window_minutes: parsed.data.pickupWindowMinutes,
      p_idempotency_key: parsed.data.idempotencyKey,
    });
    return {
      status: "success",
      message: result.idempotent_replay
        ? "Session creation was already completed safely."
        : "Draft session created with new student and staff access codes.",
      idempotentReplay: result.idempotent_replay,
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function executeConfigureAdminSession(
  client: AdminDatabaseClient,
  input: Record<string, unknown>,
): Promise<AdminActionResult> {
  const parsed = adminSessionConfigurationSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const session = await requireOpenSession(client);
    const result = await sessionRpc(
      client,
      "admin_configure_session",
      {
        p_session_id: session.id,
        p_rental_duration_minutes: parsed.data.rentalDurationMinutes,
        p_pickup_window_minutes: parsed.data.pickupWindowMinutes,
      },
      session.id,
    );
    return {
      status: "success",
      message: result.idempotent_replay
        ? "Session durations were already set to those values."
        : "Session durations updated.",
      idempotentReplay: result.idempotent_replay,
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function executeStartAdminSession(
  client: AdminDatabaseClient,
): Promise<AdminActionResult> {
  try {
    const session = await requireOpenSession(client);
    const result = await sessionRpc(
      client,
      "admin_start_session",
      { p_session_id: session.id },
      session.id,
    );
    return {
      status: "success",
      message: result.idempotent_replay
        ? "Session was already active."
        : "Session started. Student signup and staff links are now active.",
      idempotentReplay: result.idempotent_replay,
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function executeEndAdminSession(
  client: AdminDatabaseClient,
): Promise<AdminActionResult> {
  try {
    const session = await requireDisplayedSession(client);
    const result = await sessionRpc(
      client,
      "admin_end_session",
      { p_session_id: session.id },
      session.id,
    );
    return {
      status: "success",
      message: result.idempotent_replay
        ? "Session was already closed."
        : "Session ended. Signup and staff operations are now closed.",
      idempotentReplay: result.idempotent_replay,
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function executeAddAdminBins(
  client: AdminDatabaseClient,
  input: Record<string, unknown>,
): Promise<AdminActionResult> {
  const parsed = adminBinMutationSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const session = await requireOpenSession(client);
    const { data, error } = await client.rpc("admin_add_bins", {
      p_session_id: session.id,
      p_bin_numbers: parsed.data.binNumbers,
    });
    if (error)
      throw new QueueOperationError(parseQueueErrorCode(error.message));
    const result = adminBinsRpcResponseSchema.safeParse(data);
    if (!result.success) throw databaseFailure();
    const duplicateBins = Array.from(
      new Set([...parsed.data.duplicateInputs, ...result.data.duplicates]),
    ).sort((left, right) => Number(left) - Number(right));
    const addedBins = result.data.added;
    return {
      status: "success",
      message:
        addedBins.length === 0
          ? "No bins were added; every submitted number was already present."
          : `Added ${addedBins.length} bin${addedBins.length === 1 ? "" : "s"}.`,
      addedBins,
      duplicateBins,
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function executeNotifyAdminRental(
  client: AdminDatabaseClient,
  input: Record<string, unknown>,
): Promise<AdminActionResult> {
  const parsed = adminNotifySchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const session = await requireDisplayedSession(client);
    const { data, error } = await client.rpc("admin_notify_rental", {
      p_session_id: session.id,
      p_rental_id: parsed.data.rentalId,
      p_idempotency_key: parsed.data.idempotencyKey,
    });
    if (error)
      throw new QueueOperationError(parseQueueErrorCode(error.message));
    const result = adminNotifyRpcResponseSchema.safeParse(data);
    if (!result.success) throw databaseFailure();
    return {
      status: "success",
      message: result.data.idempotent_replay
        ? "That notification was already queued safely."
        : "Rental-time notification queued for Ticket 5 delivery.",
      idempotentReplay: result.data.idempotent_replay,
    };
  } catch (error) {
    return actionError(error);
  }
}
