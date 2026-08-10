"use server";

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
  };

  try {
    return await executeStudentSignup(createAdminClient(), sessionCode, input);
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
