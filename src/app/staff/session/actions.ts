"use server";

import {
  executeCheckout,
  executeCheckoutLookup,
  executeReturn,
  executeReturnLookup,
  type CheckoutConfirmationState,
  type CheckoutLookupState,
  type ReturnConfirmationState,
  type ReturnLookupState,
} from "@/lib/queue/staff-station";
import { requireStaffSession } from "@/lib/auth/staff";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

function formValue(
  formData: FormData,
  name: string,
): FormDataEntryValue | null {
  return formData.get(name);
}

async function authorize() {
  const client = createAdminClient();
  const staff = await requireStaffSession(client);
  const limit = await consumeRateLimit(
    client,
    "staff_operation",
    staff.tokenHash,
  );
  if (!limit.allowed) throw new Error("Staff operation rate limited");
  return { client, sessionId: staff.sessionId };
}

export async function lookupCheckout(
  _previousState: CheckoutLookupState,
  formData: FormData,
): Promise<CheckoutLookupState> {
  const input = { pickupCode: formValue(formData, "pickupCode") };
  try {
    const auth = await authorize();
    return await executeCheckoutLookup(auth.client, auth.sessionId, input);
  } catch {
    return {
      status: "error",
      values: {
        pickupCode:
          typeof input.pickupCode === "string" ? input.pickupCode : "",
      },
      fieldErrors: {},
      formError:
        "Staff authorization could not be verified. Reopen the staff link.",
    };
  }
}

export async function confirmCheckout(
  pickupCode: string,
  idempotencyKey: string,
  _previousState: CheckoutConfirmationState,
  formData: FormData,
): Promise<CheckoutConfirmationState> {
  const input = {
    binNumber: formValue(formData, "binNumber"),
    pantherCardCollected: formValue(formData, "pantherCardCollected"),
  };
  try {
    const auth = await authorize();
    return await executeCheckout(
      auth.client,
      auth.sessionId,
      pickupCode,
      idempotencyKey,
      input,
    );
  } catch {
    return {
      status: "error",
      values: {
        binNumber: typeof input.binNumber === "string" ? input.binNumber : "",
        pantherCardCollected: input.pantherCardCollected === "on",
      },
      fieldErrors: {},
      formError:
        "Staff authorization could not be verified. Reopen the staff link.",
    };
  }
}

export async function lookupReturn(
  _previousState: ReturnLookupState,
  formData: FormData,
): Promise<ReturnLookupState> {
  const input = { binNumber: formValue(formData, "binNumber") };
  try {
    const auth = await authorize();
    return await executeReturnLookup(auth.client, auth.sessionId, input);
  } catch {
    return {
      status: "error",
      values: {
        binNumber: typeof input.binNumber === "string" ? input.binNumber : "",
      },
      fieldErrors: {},
      formError:
        "Staff authorization could not be verified. Reopen the staff link.",
    };
  }
}

export async function confirmReturn(
  idempotencyKey: string,
  _previousState: ReturnConfirmationState,
  formData: FormData,
): Promise<ReturnConfirmationState> {
  const input = {
    binNumber: formValue(formData, "binNumber"),
    pantherCardReturned: formValue(formData, "pantherCardReturned"),
  };
  try {
    const auth = await authorize();
    return await executeReturn(
      auth.client,
      auth.sessionId,
      idempotencyKey,
      input,
    );
  } catch {
    return {
      status: "error",
      values: {
        binNumber: typeof input.binNumber === "string" ? input.binNumber : "",
        pantherCardReturned: input.pantherCardReturned === "on",
      },
      fieldErrors: {},
      formError:
        "Staff authorization could not be verified. Reopen the staff link.",
    };
  }
}
