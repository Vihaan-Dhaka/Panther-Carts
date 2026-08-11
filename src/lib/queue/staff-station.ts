import "server-only";

import { randomUUID } from "node:crypto";
import { QueueErrorCode, QueueOperationError } from "./errors";
import {
  checkoutRental,
  findStaffSession,
  getCheckoutPreview,
  getPublicStudentForSession,
  getReturnPreview,
  returnRental,
  type CheckoutPreview,
  type ReturnPreview,
  type StaffRentalDatabaseClient,
  type StaffSession,
  type StaffStudent,
} from "./staff-rentals";
import {
  checkoutConfirmationSchema,
  checkoutLookupSchema,
  idempotencyKeySchema,
  pickupCodeSchema,
  returnConfirmationSchema,
  returnLookupSchema,
  staffAccessCodeSchema,
} from "@/lib/validation/staff";

type FieldErrors<T extends string> = Partial<Record<T, string[]>>;

export type CheckoutLookupValues = { pickupCode: string };
export type CheckoutLookupState =
  | {
      status: "idle" | "error";
      values: CheckoutLookupValues;
      fieldErrors: FieldErrors<"pickupCode">;
      formError: string | null;
    }
  | {
      status: "preview";
      values: CheckoutLookupValues;
      preview: CheckoutPreview;
      idempotencyKey: string;
    };

export type CheckoutConfirmationValues = {
  binNumber: string;
  pantherCardCollected: boolean;
};
export type CheckoutConfirmationState =
  | {
      status: "idle" | "error";
      values: CheckoutConfirmationValues;
      fieldErrors: FieldErrors<"binNumber" | "pantherCardCollected">;
      formError: string | null;
    }
  | {
      status: "success";
      result: {
        student: StaffStudent;
        binNumber: string;
        swapped: boolean;
        idempotentReplay: boolean;
      };
    };

export type ReturnLookupValues = { binNumber: string };
export type ReturnLookupState =
  | {
      status: "idle" | "error";
      values: ReturnLookupValues;
      fieldErrors: FieldErrors<"binNumber">;
      formError: string | null;
    }
  | {
      status: "preview";
      values: ReturnLookupValues;
      preview: ReturnPreview;
      idempotencyKey: string;
    };

export type ReturnConfirmationValues = {
  binNumber: string;
  pantherCardReturned: boolean;
};
export type ReturnConfirmationState =
  | {
      status: "idle" | "error";
      values: ReturnConfirmationValues;
      fieldErrors: FieldErrors<"binNumber" | "pantherCardReturned">;
      formError: string | null;
    }
  | {
      status: "success";
      result: {
        student: StaffStudent;
        binNumber: string;
        nextReservationCreated: boolean;
        idempotentReplay: boolean;
      };
    };

export type StaffStationAvailability =
  { available: true } | { available: false; message: string };

const INVALID_STAFF_MESSAGE =
  "This staff station link is invalid. Ask an administrator for the current link.";
const INACTIVE_SESSION_MESSAGE =
  "This staff session is not active. Checkout and return are unavailable.";
const AVAILABILITY_FAILURE_MESSAGE =
  "We could not check this staff session right now. Please try again.";
const CHECKOUT_FAILURE_MESSAGE =
  "We could not complete checkout right now. Please try again.";
const RETURN_FAILURE_MESSAGE =
  "We could not complete check-in right now. Please try again.";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function newIdempotencyKey(): string {
  return idempotencyKeySchema.parse(randomUUID());
}

async function requireActiveStaffSession(
  client: StaffRentalDatabaseClient,
  staffCodeInput: unknown,
): Promise<StaffSession> {
  const code = staffAccessCodeSchema.safeParse(staffCodeInput);
  if (!code.success) {
    throw new QueueOperationError(QueueErrorCode.SESSION_NOT_FOUND);
  }

  const session = await findStaffSession(client, code.data);
  if (!session) {
    throw new QueueOperationError(QueueErrorCode.SESSION_NOT_FOUND);
  }
  if (session.status !== "ACTIVE") {
    throw new QueueOperationError(QueueErrorCode.SESSION_NOT_ACTIVE);
  }
  return session;
}

function checkoutLookupError(
  values: CheckoutLookupValues,
  error: QueueOperationError,
): CheckoutLookupState {
  switch (error.code) {
    case QueueErrorCode.SESSION_NOT_FOUND:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: INVALID_STAFF_MESSAGE,
      };
    case QueueErrorCode.SESSION_NOT_ACTIVE:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: INACTIVE_SESSION_MESSAGE,
      };
    case QueueErrorCode.PICKUP_CODE_INVALID:
      return {
        status: "error",
        values,
        fieldErrors: {
          pickupCode: ["No ready rental matches that pickup code"],
        },
        formError: null,
      };
    case QueueErrorCode.RESERVATION_NOT_ACTIVE:
      return {
        status: "error",
        values,
        fieldErrors: {
          pickupCode: ["That pickup reservation is no longer active"],
        },
        formError: null,
      };
    case QueueErrorCode.RESERVATION_EXPIRED:
      return {
        status: "error",
        values,
        fieldErrors: { pickupCode: ["That pickup code has expired"] },
        formError: null,
      };
    case QueueErrorCode.BIN_NOT_FOUND:
    case QueueErrorCode.BIN_NOT_USABLE:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: "No eligible bin is available for that pickup right now.",
      };
    default:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: CHECKOUT_FAILURE_MESSAGE,
      };
  }
}

function checkoutConfirmationError(
  values: CheckoutConfirmationValues,
  error: QueueOperationError,
): CheckoutConfirmationState {
  const state = (
    formError: string | null,
    fieldErrors: FieldErrors<"binNumber" | "pantherCardCollected"> = {},
  ): CheckoutConfirmationState => ({
    status: "error",
    values,
    fieldErrors,
    formError,
  });

  switch (error.code) {
    case QueueErrorCode.SESSION_NOT_FOUND:
      return state(INVALID_STAFF_MESSAGE);
    case QueueErrorCode.SESSION_NOT_ACTIVE:
      return state(INACTIVE_SESSION_MESSAGE);
    case QueueErrorCode.PICKUP_CODE_INVALID:
      return state("That pickup code is no longer valid. Look it up again.");
    case QueueErrorCode.RESERVATION_NOT_ACTIVE:
      return state(
        "That pickup reservation is no longer active. Look it up again.",
      );
    case QueueErrorCode.RESERVATION_EXPIRED:
      return state("That pickup reservation has expired. Look it up again.");
    case QueueErrorCode.BIN_NOT_FOUND:
      return state(null, {
        binNumber: ["That bin does not exist in this session"],
      });
    case QueueErrorCode.BIN_NOT_USABLE:
      return state(null, {
        binNumber: ["That bin is no longer eligible for checkout"],
      });
    case QueueErrorCode.PANTHERCARD_REQUIRED:
      return state(null, {
        pantherCardCollected: [
          "Confirm that the physical PantherCard was collected",
        ],
      });
    case QueueErrorCode.IDEMPOTENCY_KEY_REQUIRED:
      return state("This confirmation expired. Look up the pickup code again.");
    case QueueErrorCode.IDEMPOTENCY_CONFLICT:
      return state(
        "This confirmation was already used. Look up the pickup code again.",
      );
    default:
      return state(CHECKOUT_FAILURE_MESSAGE);
  }
}

function returnLookupError(
  values: ReturnLookupValues,
  error: QueueOperationError,
): ReturnLookupState {
  switch (error.code) {
    case QueueErrorCode.SESSION_NOT_FOUND:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: INVALID_STAFF_MESSAGE,
      };
    case QueueErrorCode.SESSION_NOT_ACTIVE:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: INACTIVE_SESSION_MESSAGE,
      };
    case QueueErrorCode.BIN_NOT_FOUND:
      return {
        status: "error",
        values,
        fieldErrors: { binNumber: ["That bin does not exist in this session"] },
        formError: null,
      };
    case QueueErrorCode.NO_ACTIVE_RENTAL:
      return {
        status: "error",
        values,
        fieldErrors: { binNumber: ["That bin has no active rental"] },
        formError: null,
      };
    default:
      return {
        status: "error",
        values,
        fieldErrors: {},
        formError: RETURN_FAILURE_MESSAGE,
      };
  }
}

function returnConfirmationError(
  values: ReturnConfirmationValues,
  error: QueueOperationError,
): ReturnConfirmationState {
  const state = (
    formError: string | null,
    fieldErrors: FieldErrors<"binNumber" | "pantherCardReturned"> = {},
  ): ReturnConfirmationState => ({
    status: "error",
    values,
    fieldErrors,
    formError,
  });

  switch (error.code) {
    case QueueErrorCode.SESSION_NOT_FOUND:
      return state(INVALID_STAFF_MESSAGE);
    case QueueErrorCode.SESSION_NOT_ACTIVE:
      return state(INACTIVE_SESSION_MESSAGE);
    case QueueErrorCode.BIN_NOT_FOUND:
      return state(null, {
        binNumber: ["That bin does not exist in this session"],
      });
    case QueueErrorCode.NO_ACTIVE_RENTAL:
      return state(
        "That bin no longer has an active rental. Look it up again.",
      );
    case QueueErrorCode.PANTHERCARD_REQUIRED:
      return state(null, {
        pantherCardReturned: [
          "Confirm that the physical PantherCard was returned",
        ],
      });
    case QueueErrorCode.IDEMPOTENCY_KEY_REQUIRED:
      return state("This confirmation expired. Look up the bin again.");
    case QueueErrorCode.IDEMPOTENCY_CONFLICT:
      return state(
        "This confirmation was already used. Look up the bin again.",
      );
    default:
      return state(RETURN_FAILURE_MESSAGE);
  }
}

export async function getStaffStationAvailability(
  client: StaffRentalDatabaseClient,
  staffCodeInput: unknown,
): Promise<StaffStationAvailability> {
  try {
    await requireActiveStaffSession(client, staffCodeInput);
    return { available: true };
  } catch (error) {
    if (error instanceof QueueOperationError) {
      if (error.code === QueueErrorCode.SESSION_NOT_FOUND) {
        return { available: false, message: INVALID_STAFF_MESSAGE };
      }
      if (error.code === QueueErrorCode.SESSION_NOT_ACTIVE) {
        return { available: false, message: INACTIVE_SESSION_MESSAGE };
      }
    }
    return { available: false, message: AVAILABILITY_FAILURE_MESSAGE };
  }
}

export async function executeCheckoutLookup(
  client: StaffRentalDatabaseClient,
  staffCodeInput: unknown,
  input: { pickupCode?: unknown },
): Promise<CheckoutLookupState> {
  const values = { pickupCode: stringValue(input.pickupCode) };
  const parsed = checkoutLookupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      values,
      fieldErrors: parsed.error.flatten().fieldErrors,
      formError: null,
    };
  }

  try {
    const session = await requireActiveStaffSession(client, staffCodeInput);
    return {
      status: "preview",
      values: { pickupCode: parsed.data.pickupCode },
      preview: await getCheckoutPreview(
        client,
        session.id,
        parsed.data.pickupCode,
      ),
      idempotencyKey: newIdempotencyKey(),
    };
  } catch (error) {
    return checkoutLookupError(
      values,
      error instanceof QueueOperationError
        ? error
        : new QueueOperationError(null),
    );
  }
}

export async function executeCheckout(
  client: StaffRentalDatabaseClient,
  staffCodeInput: unknown,
  pickupCodeInput: unknown,
  idempotencyKeyInput: unknown,
  input: { binNumber?: unknown; pantherCardCollected?: unknown },
): Promise<CheckoutConfirmationState> {
  const values = {
    binNumber: stringValue(input.binNumber),
    pantherCardCollected: input.pantherCardCollected === "on",
  };
  const pickupCode = pickupCodeSchema.safeParse(pickupCodeInput);
  const confirmation = checkoutConfirmationSchema.safeParse({
    ...input,
    idempotencyKey: idempotencyKeyInput,
  });

  if (!pickupCode.success) {
    return checkoutConfirmationError(
      values,
      new QueueOperationError(QueueErrorCode.PICKUP_CODE_INVALID),
    );
  }
  if (!confirmation.success) {
    const errors = confirmation.error.flatten().fieldErrors;
    return {
      status: "error",
      values,
      fieldErrors: {
        binNumber: errors.binNumber,
        pantherCardCollected: errors.pantherCardCollected,
      },
      formError: errors.idempotencyKey?.[0] ?? null,
    };
  }

  try {
    const session = await requireActiveStaffSession(client, staffCodeInput);
    const result = await checkoutRental(
      client,
      session.id,
      pickupCode.data,
      confirmation.data,
    );
    const student = await getPublicStudentForSession(
      client,
      session.id,
      result.studentId,
    );
    return {
      status: "success",
      result: {
        student,
        binNumber: confirmation.data.binNumber,
        swapped: result.swapped,
        idempotentReplay: result.idempotentReplay,
      },
    };
  } catch (error) {
    return checkoutConfirmationError(
      values,
      error instanceof QueueOperationError
        ? error
        : new QueueOperationError(null),
    );
  }
}

export async function executeReturnLookup(
  client: StaffRentalDatabaseClient,
  staffCodeInput: unknown,
  input: { binNumber?: unknown },
): Promise<ReturnLookupState> {
  const values = { binNumber: stringValue(input.binNumber) };
  const parsed = returnLookupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      values,
      fieldErrors: parsed.error.flatten().fieldErrors,
      formError: null,
    };
  }

  try {
    const session = await requireActiveStaffSession(client, staffCodeInput);
    return {
      status: "preview",
      values: { binNumber: parsed.data.binNumber },
      preview: await getReturnPreview(
        client,
        session.id,
        parsed.data.binNumber,
      ),
      idempotencyKey: newIdempotencyKey(),
    };
  } catch (error) {
    return returnLookupError(
      values,
      error instanceof QueueOperationError
        ? error
        : new QueueOperationError(null),
    );
  }
}

export async function executeReturn(
  client: StaffRentalDatabaseClient,
  staffCodeInput: unknown,
  idempotencyKeyInput: unknown,
  input: { binNumber?: unknown; pantherCardReturned?: unknown },
): Promise<ReturnConfirmationState> {
  const values = {
    binNumber: stringValue(input.binNumber),
    pantherCardReturned: input.pantherCardReturned === "on",
  };
  const confirmation = returnConfirmationSchema.safeParse({
    ...input,
    idempotencyKey: idempotencyKeyInput,
  });
  if (!confirmation.success) {
    const errors = confirmation.error.flatten().fieldErrors;
    return {
      status: "error",
      values,
      fieldErrors: {
        binNumber: errors.binNumber,
        pantherCardReturned: errors.pantherCardReturned,
      },
      formError: errors.idempotencyKey?.[0] ?? null,
    };
  }

  try {
    const session = await requireActiveStaffSession(client, staffCodeInput);
    const result = await returnRental(client, session.id, confirmation.data);
    const student = await getPublicStudentForSession(
      client,
      session.id,
      result.studentId,
    );
    return {
      status: "success",
      result: {
        student,
        binNumber: confirmation.data.binNumber,
        nextReservationCreated: result.nextReservationCreated,
        idempotentReplay: result.idempotentReplay,
      },
    };
  } catch (error) {
    return returnConfirmationError(
      values,
      error instanceof QueueOperationError
        ? error
        : new QueueOperationError(null),
    );
  }
}
