"use server";

import { refresh } from "next/cache";
import {
  executeAddAdminBins,
  executeConfigureAdminSession,
  executeCreateAdminSession,
  executeEndAdminSession,
  executeNotifyAdminRental,
  executeStartAdminSession,
} from "@/lib/admin/dashboard";
import type { AdminActionResult } from "@/lib/admin/types";
import { createAdminClient } from "@/lib/supabase/admin";

const UNEXPECTED: AdminActionResult = {
  status: "error",
  message: "We could not complete that admin action. Please try again.",
  fieldErrors: {},
};

async function runAdminAction(
  operation: () => Promise<AdminActionResult>,
): Promise<AdminActionResult> {
  let result: AdminActionResult;
  try {
    result = await operation();
  } catch {
    return UNEXPECTED;
  }
  if (result.status === "success") refresh();
  return result;
}

export async function createSessionAction(
  _previousState: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction(() =>
    executeCreateAdminSession(createAdminClient(), {
      name: formData.get("name"),
      rentalDurationMinutes: formData.get("rentalDurationMinutes"),
      pickupWindowMinutes: formData.get("pickupWindowMinutes"),
      idempotencyKey: formData.get("idempotencyKey"),
    }),
  );
}

export async function configureSessionAction(
  _previousState: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction(() =>
    executeConfigureAdminSession(createAdminClient(), {
      rentalDurationMinutes: formData.get("rentalDurationMinutes"),
      pickupWindowMinutes: formData.get("pickupWindowMinutes"),
    }),
  );
}

export async function startSessionAction(
  _previousState: AdminActionResult | null,
  _formData: FormData,
): Promise<AdminActionResult> {
  void _previousState;
  void _formData;
  return runAdminAction(() => executeStartAdminSession(createAdminClient()));
}

export async function endSessionAction(
  _previousState: AdminActionResult | null,
  _formData: FormData,
): Promise<AdminActionResult> {
  void _previousState;
  void _formData;
  return runAdminAction(() => executeEndAdminSession(createAdminClient()));
}

export async function addBinsAction(
  _previousState: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction(() =>
    executeAddAdminBins(createAdminClient(), {
      mode: formData.get("mode"),
      binNumber: formData.get("binNumber"),
      rangeStart: formData.get("rangeStart"),
      rangeEnd: formData.get("rangeEnd"),
      pastedBins: formData.get("pastedBins"),
    }),
  );
}

export async function notifyRentalAction(
  _previousState: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction(() =>
    executeNotifyAdminRental(createAdminClient(), {
      rentalId: formData.get("rentalId"),
      idempotencyKey: formData.get("idempotencyKey"),
    }),
  );
}
