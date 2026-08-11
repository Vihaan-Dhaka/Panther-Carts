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
  try {
    const result = await operation();
    if (result.status === "success") refresh();
    return result;
  } catch {
    return UNEXPECTED;
  }
}

export async function createSessionAction(
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
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction(() =>
    executeConfigureAdminSession(createAdminClient(), {
      rentalDurationMinutes: formData.get("rentalDurationMinutes"),
      pickupWindowMinutes: formData.get("pickupWindowMinutes"),
    }),
  );
}

export async function startSessionAction(): Promise<AdminActionResult> {
  return runAdminAction(() => executeStartAdminSession(createAdminClient()));
}

export async function endSessionAction(): Promise<AdminActionResult> {
  return runAdminAction(() => executeEndAdminSession(createAdminClient()));
}

export async function addBinsAction(
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
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction(() =>
    executeNotifyAdminRental(createAdminClient(), {
      rentalId: formData.get("rentalId"),
      idempotencyKey: formData.get("idempotencyKey"),
    }),
  );
}
