import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseQueueErrorCode, QueueOperationError } from "./errors";
import {
  activeRentalLookupRowSchema,
  activeReservationRowSchema,
  checkoutQueueEntryRowSchema,
  checkoutRpcResponseSchema,
  publicStudentRowSchema,
  returnRpcResponseSchema,
  staffBinRowSchema,
  staffSessionRowSchema,
  type CheckoutConfirmationValues,
  type ReturnConfirmationValues,
} from "@/lib/validation/staff";

export type StaffRentalDatabaseClient = Pick<SupabaseClient, "from" | "rpc">;

export type StaffSession = z.infer<typeof staffSessionRowSchema>;

export type StaffStudent = {
  fullName: string;
  pantherId: string;
};

export type CheckoutPreview = {
  student: StaffStudent;
  eligibleBins: Array<{ binNumber: string; reserved: boolean }>;
};

export type ReturnPreview = {
  student: StaffStudent;
  binNumber: string;
};

export type CheckoutResult = {
  studentId: string;
  dueAt: string;
  swapped: boolean;
  idempotentReplay: boolean;
};

export type ReturnResult = {
  studentId: string;
  wasLate: boolean;
  nextReservationCreated: boolean;
  idempotentReplay: boolean;
};

const SAFE_STAFF_LABEL = "Staff station";

function databaseFailure(): QueueOperationError {
  return new QueueOperationError(null);
}

/** Resolve a staff access code for a trusted server operation. */
export async function findStaffSession(
  client: StaffRentalDatabaseClient,
  staffCode: string,
): Promise<StaffSession | null> {
  const { data, error } = await client
    .from("sessions")
    .select("id,status")
    .eq("staff_code", staffCode)
    .maybeSingle();

  if (error) {
    throw databaseFailure();
  }
  if (data === null) {
    return null;
  }

  const parsed = staffSessionRowSchema.safeParse(data);
  if (!parsed.success) {
    throw databaseFailure();
  }
  return parsed.data;
}

export async function getPublicStudentForSession(
  client: StaffRentalDatabaseClient,
  sessionId: string,
  studentId: string,
): Promise<StaffStudent> {
  const { data, error } = await client
    .from("students")
    .select("full_name,panther_id")
    .eq("session_id", sessionId)
    .eq("id", studentId)
    .maybeSingle();

  if (error || data === null) {
    throw databaseFailure();
  }

  const parsed = publicStudentRowSchema.safeParse(data);
  if (!parsed.success) {
    throw databaseFailure();
  }

  return {
    fullName: parsed.data.full_name,
    pantherId: parsed.data.panther_id,
  };
}

/** Informational checkout lookup. The checkout RPC rechecks every invariant. */
export async function getCheckoutPreview(
  client: StaffRentalDatabaseClient,
  sessionId: string,
  pickupCode: string,
): Promise<CheckoutPreview> {
  const { data: entryData, error: entryError } = await client
    .from("queue_entries")
    .select("id,student_id,reserved_bin_id,pickup_expires_at,status")
    .eq("session_id", sessionId)
    .eq("pickup_code", pickupCode)
    .eq("status", "READY")
    .maybeSingle();

  if (entryError) {
    throw databaseFailure();
  }
  if (entryData === null) {
    throw new QueueOperationError("PICKUP_CODE_INVALID");
  }

  const entry = checkoutQueueEntryRowSchema.safeParse(entryData);
  if (!entry.success) {
    throw databaseFailure();
  }

  if (new Date(entry.data.pickup_expires_at).getTime() <= Date.now()) {
    throw new QueueOperationError("RESERVATION_EXPIRED");
  }

  const { data: reservationData, error: reservationError } = await client
    .from("reservations")
    .select("bin_id,status,expires_at")
    .eq("session_id", sessionId)
    .eq("queue_entry_id", entry.data.id)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (reservationError) {
    throw databaseFailure();
  }
  if (reservationData === null) {
    throw new QueueOperationError("RESERVATION_NOT_ACTIVE");
  }

  const reservation = activeReservationRowSchema.safeParse(reservationData);
  if (!reservation.success) {
    throw databaseFailure();
  }
  if (new Date(reservation.data.expires_at).getTime() <= Date.now()) {
    throw new QueueOperationError("RESERVATION_EXPIRED");
  }
  if (reservation.data.bin_id !== entry.data.reserved_bin_id) {
    throw databaseFailure();
  }

  const student = await getPublicStudentForSession(
    client,
    sessionId,
    entry.data.student_id,
  );
  const { data: binsData, error: binsError } = await client
    .from("bins")
    .select("id,bin_number,status")
    .eq("session_id", sessionId)
    .order("bin_number");

  if (binsError) {
    throw databaseFailure();
  }

  const bins = z.array(staffBinRowSchema).safeParse(binsData);
  if (!bins.success) {
    throw databaseFailure();
  }

  const reservedBin = bins.data.find(
    (bin) => bin.id === entry.data.reserved_bin_id,
  );
  if (!reservedBin || reservedBin.status !== "RESERVED") {
    throw new QueueOperationError("BIN_NOT_USABLE");
  }

  return {
    student,
    eligibleBins: bins.data
      .filter(
        (bin) =>
          bin.id === entry.data.reserved_bin_id || bin.status === "AVAILABLE",
      )
      .map((bin) => ({
        binNumber: bin.bin_number,
        reserved: bin.id === entry.data.reserved_bin_id,
      })),
  };
}

/** Informational return lookup. The return RPC remains authoritative. */
export async function getReturnPreview(
  client: StaffRentalDatabaseClient,
  sessionId: string,
  binNumber: string,
): Promise<ReturnPreview> {
  const { data: binData, error: binError } = await client
    .from("bins")
    .select("id,bin_number,status")
    .eq("session_id", sessionId)
    .eq("bin_number", binNumber)
    .maybeSingle();

  if (binError) {
    throw databaseFailure();
  }
  if (binData === null) {
    throw new QueueOperationError("BIN_NOT_FOUND");
  }

  const bin = staffBinRowSchema.safeParse(binData);
  if (!bin.success) {
    throw databaseFailure();
  }

  const { data: rentalData, error: rentalError } = await client
    .from("rentals")
    .select("student_id,status")
    .eq("session_id", sessionId)
    .eq("bin_id", bin.data.id)
    .eq("status", "OUT")
    .maybeSingle();

  if (rentalError) {
    throw databaseFailure();
  }
  if (rentalData === null) {
    throw new QueueOperationError("NO_ACTIVE_RENTAL");
  }

  const rental = activeRentalLookupRowSchema.safeParse(rentalData);
  if (!rental.success) {
    throw databaseFailure();
  }

  return {
    student: await getPublicStudentForSession(
      client,
      sessionId,
      rental.data.student_id,
    ),
    binNumber: bin.data.bin_number,
  };
}

/** Thin typed wrapper around the authoritative PostgreSQL checkout RPC. */
export async function checkoutRental(
  client: StaffRentalDatabaseClient,
  sessionId: string,
  pickupCode: string,
  input: CheckoutConfirmationValues,
): Promise<CheckoutResult> {
  const { data, error } = await client.rpc("checkout", {
    p_session_id: sessionId,
    p_pickup_code: pickupCode,
    p_bin_number: input.binNumber,
    p_panthercard_collected: input.pantherCardCollected,
    p_staff_label: SAFE_STAFF_LABEL,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    throw new QueueOperationError(parseQueueErrorCode(error.message));
  }

  const parsed = checkoutRpcResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw databaseFailure();
  }
  if (
    parsed.data.rental.session_id !== sessionId ||
    parsed.data.rental.checkout_idempotency_key !== input.idempotencyKey
  ) {
    throw databaseFailure();
  }

  return {
    studentId: parsed.data.rental.student_id,
    dueAt: parsed.data.rental.due_at,
    swapped: parsed.data.swapped,
    idempotentReplay: parsed.data.idempotent_replay,
  };
}

/** Thin typed wrapper around the authoritative PostgreSQL return_rental RPC. */
export async function returnRental(
  client: StaffRentalDatabaseClient,
  sessionId: string,
  input: ReturnConfirmationValues,
): Promise<ReturnResult> {
  const { data, error } = await client.rpc("return_rental", {
    p_session_id: sessionId,
    p_bin_number: input.binNumber,
    p_panthercard_returned: input.pantherCardReturned,
    p_staff_label: SAFE_STAFF_LABEL,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    throw new QueueOperationError(parseQueueErrorCode(error.message));
  }

  const parsed = returnRpcResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw databaseFailure();
  }
  if (
    parsed.data.rental.session_id !== sessionId ||
    parsed.data.rental.return_idempotency_key !== input.idempotencyKey
  ) {
    throw databaseFailure();
  }

  return {
    studentId: parsed.data.rental.student_id,
    wasLate: parsed.data.rental.was_late,
    nextReservationCreated: parsed.data.reservation !== null,
    idempotentReplay: parsed.data.idempotent_replay,
  };
}
