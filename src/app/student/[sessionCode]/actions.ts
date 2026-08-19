"use server";

import { headers } from "next/headers";
import { consumeRateLimit, requestIp } from "@/lib/auth/rate-limit";
import {
  executeStudentSignup,
  preserveStudentSignupValues,
  type StudentSignupState,
} from "@/lib/queue/student-signup";
import { createAdminClient } from "@/lib/supabase/admin";

export async function submitStudentSignup(
  sessionCode: string,
  _previousState: StudentSignupState,
  formData: FormData,
): Promise<StudentSignupState> {
  const input = {
    fullName: formData.get("fullName"),
    pantherId: formData.get("pantherId"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    smsConsent: formData.get("smsConsent"),
  };

  try {
    const client = createAdminClient();
    const limit = await consumeRateLimit(
      client,
      "student_signup",
      requestIp(await headers()),
      sessionCode.slice(0, 200),
    );
    if (!limit.allowed) {
      return {
        status: "error",
        values: preserveStudentSignupValues(input),
        fieldErrors: {},
        formError:
          "Too many signup attempts were submitted. Wait and try again.",
      };
    }
    return await executeStudentSignup(client, sessionCode, input);
  } catch {
    return {
      status: "error",
      values: preserveStudentSignupValues(input),
      fieldErrors: {},
      formError:
        "We could not complete your signup right now. Please try again.",
    };
  }
}
