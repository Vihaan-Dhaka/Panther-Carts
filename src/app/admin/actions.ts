"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  executeAddAdminBins,
  executeConfigureAdminSession,
  executeCreateAdminSession,
  executeEndAdminSession,
  executeNotifyAdminRental,
  executeStartAdminSession,
} from "@/lib/admin/dashboard";
import type { AdminActionResult } from "@/lib/admin/types";
import { AuthorizationError, requireAdmin } from "@/lib/auth/admin";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UNEXPECTED: AdminActionResult = {
  status: "error",
  message: "We could not complete that admin action. Please try again.",
  fieldErrors: {},
};

const UNAUTHORIZED: AdminActionResult = {
  status: "error",
  message: "Your admin session is not authorized. Sign in and try again.",
  fieldErrors: {},
};

const RATE_LIMITED: AdminActionResult = {
  status: "error",
  message:
    "Too many admin requests were submitted. Wait a moment and try again.",
  fieldErrors: {},
};

async function runAdminAction(
  operation: (
    client: ReturnType<typeof createAdminClient>,
  ) => Promise<AdminActionResult>,
): Promise<AdminActionResult> {
  let result: AdminActionResult;
  try {
    const admin = await requireAdmin();
    const client = createAdminClient();
    const limit = await consumeRateLimit(
      client,
      "admin_operation",
      admin.userId,
    );
    if (!limit.allowed) return RATE_LIMITED;
    result = await operation(client);
  } catch (error) {
    if (error instanceof AuthorizationError) return UNAUTHORIZED;
    return UNEXPECTED;
  }
  if (result.status === "success") refresh();
  return result;
}

export async function createSessionAction(
  _previousState: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction((client) =>
    executeCreateAdminSession(client, {
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
  return runAdminAction((client) =>
    executeConfigureAdminSession(client, {
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
  return runAdminAction((client) => executeStartAdminSession(client));
}

export async function endSessionAction(
  _previousState: AdminActionResult | null,
  _formData: FormData,
): Promise<AdminActionResult> {
  void _previousState;
  void _formData;
  return runAdminAction((client) => executeEndAdminSession(client));
}

export async function addBinsAction(
  _previousState: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  return runAdminAction((client) =>
    executeAddAdminBins(client, {
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
  return runAdminAction((client) =>
    executeNotifyAdminRental(client, {
      rentalId: formData.get("rentalId"),
      idempotencyKey: formData.get("idempotencyKey"),
    }),
  );
}

export async function logoutAdminAction(): Promise<never> {
  const client = await createClient();
  await client.auth.signOut();
  redirect("/admin/login");
}
