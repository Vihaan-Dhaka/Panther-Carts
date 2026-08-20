"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  exchangeStaffCredential,
  STAFF_SESSION_COOKIE,
  staffSessionCookieOptions,
} from "@/lib/auth/staff";
import { consumeRateLimit, requestIp } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { staffManualAccessCodeSchema } from "@/lib/validation/auth";

export type StaffAccessState = {
  status: "idle" | "error";
  fieldErrors: Partial<Record<"accessCode", string[]>>;
  formError: string | null;
};

const ACCESS_ERROR =
  "Staff access was not accepted. Check the code or try again later.";

export async function verifyStaffAccessCodeAction(
  _previousState: StaffAccessState,
  formData: FormData,
): Promise<StaffAccessState> {
  const accessCode = staffManualAccessCodeSchema.safeParse(
    formData.get("accessCode"),
  );
  if (!accessCode.success) {
    return {
      status: "error",
      fieldErrors: {
        accessCode: accessCode.error.issues.map((issue) => issue.message),
      },
      formError: null,
    };
  }

  try {
    const client = createAdminClient();
    const limit = await consumeRateLimit(
      client,
      "staff_code_exchange",
      requestIp(await headers()),
    );
    if (!limit.allowed) {
      return { status: "error", fieldErrors: {}, formError: ACCESS_ERROR };
    }
    const exchange = await exchangeStaffCredential(
      client,
      "code",
      accessCode.data,
    );
    if (!exchange) {
      return { status: "error", fieldErrors: {}, formError: ACCESS_ERROR };
    }
    (await cookies()).set(
      STAFF_SESSION_COOKIE,
      exchange.token,
      staffSessionCookieOptions,
    );
  } catch {
    return { status: "error", fieldErrors: {}, formError: ACCESS_ERROR };
  }

  redirect("/staff/session");
}
