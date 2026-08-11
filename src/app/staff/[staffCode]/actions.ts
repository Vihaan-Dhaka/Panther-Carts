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
import { createAdminClient } from "@/lib/supabase/admin";

function formString(
  formData: FormData,
  name: string,
): FormDataEntryValue | null {
  return formData.get(name);
}

export async function lookupCheckout(
  staffCode: string,
  _previousState: CheckoutLookupState,
  formData: FormData,
): Promise<CheckoutLookupState> {
  const input = { pickupCode: formString(formData, "pickupCode") };
  try {
    return await executeCheckoutLookup(createAdminClient(), staffCode, input);
  } catch {
    return {
      status: "error",
      values: {
        pickupCode:
          typeof input.pickupCode === "string" ? input.pickupCode : "",
      },
      fieldErrors: {},
      formError:
        "We could not look up that pickup right now. Please try again.",
    };
  }
}

export async function confirmCheckout(
  staffCode: string,
  pickupCode: string,
  idempotencyKey: string,
  _previousState: CheckoutConfirmationState,
  formData: FormData,
): Promise<CheckoutConfirmationState> {
  const input = {
    binNumber: formString(formData, "binNumber"),
    pantherCardCollected: formString(formData, "pantherCardCollected"),
  };
  try {
    return await executeCheckout(
      createAdminClient(),
      staffCode,
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
      formError: "We could not complete checkout right now. Please try again.",
    };
  }
}

export async function lookupReturn(
  staffCode: string,
  _previousState: ReturnLookupState,
  formData: FormData,
): Promise<ReturnLookupState> {
  const input = { binNumber: formString(formData, "binNumber") };
  try {
    return await executeReturnLookup(createAdminClient(), staffCode, input);
  } catch {
    return {
      status: "error",
      values: {
        binNumber: typeof input.binNumber === "string" ? input.binNumber : "",
      },
      fieldErrors: {},
      formError:
        "We could not look up that return right now. Please try again.",
    };
  }
}

export async function confirmReturn(
  staffCode: string,
  idempotencyKey: string,
  _previousState: ReturnConfirmationState,
  formData: FormData,
): Promise<ReturnConfirmationState> {
  const input = {
    binNumber: formString(formData, "binNumber"),
    pantherCardReturned: formString(formData, "pantherCardReturned"),
  };
  try {
    return await executeReturn(
      createAdminClient(),
      staffCode,
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
      formError: "We could not complete check-in right now. Please try again.",
    };
  }
}
