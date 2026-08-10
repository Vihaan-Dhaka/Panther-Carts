import "server-only";

import { QueueErrorCode, QueueOperationError } from "@/lib/queue/errors";
import {
  findSignupSession,
  joinQueue,
  type JoinQueueResult,
  type StudentSignupDatabaseClient,
} from "@/lib/queue/join-queue";
import {
  joinQueueSchema,
  studentSessionCodeSchema,
} from "@/lib/validation/student";

export type StudentSignupFormValues = {
  fullName: string;
  pantherId: string;
  email: string;
  phone: string;
};

export type StudentSignupFieldErrors = Partial<
  Record<keyof StudentSignupFormValues, string[]>
>;

export type StudentSignupState =
  | {
      status: "idle" | "error";
      values: StudentSignupFormValues;
      fieldErrors: StudentSignupFieldErrors;
      formError: string | null;
    }
  | { status: "success"; result: JoinQueueResult };

export type StudentSignupAvailability =
  | { available: true; sessionCode: string }
  | { available: false; message: string };

const INVALID_LINK_MESSAGE =
  "This signup link is invalid. Ask staff for the current signup link.";
const INACTIVE_SESSION_MESSAGE =
  "This signup session is not active. Ask staff if signups are open.";
const UNEXPECTED_MESSAGE =
  "We could not complete your signup right now. Please try again.";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function preserveStudentSignupValues(input: {
  fullName?: unknown;
  pantherId?: unknown;
  email?: unknown;
  phone?: unknown;
}): StudentSignupFormValues {
  return {
    fullName: stringValue(input.fullName),
    pantherId: stringValue(input.pantherId),
    email: stringValue(input.email),
    phone: stringValue(input.phone),
  };
}

function errorState(
  values: StudentSignupFormValues,
  formError: string | null,
  fieldErrors: StudentSignupFieldErrors = {},
): StudentSignupState {
  return { status: "error", values, fieldErrors, formError };
}

function mapQueueError(
  error: QueueOperationError,
  values: StudentSignupFormValues,
): StudentSignupState {
  switch (error.code) {
    case QueueErrorCode.SESSION_NOT_FOUND:
      return errorState(values, INVALID_LINK_MESSAGE);
    case QueueErrorCode.SESSION_NOT_ACTIVE:
      return errorState(values, INACTIVE_SESSION_MESSAGE);
    case QueueErrorCode.DUPLICATE_ACTIVE_ENTRY:
      return errorState(values, null, {
        phone: [
          "This phone number already has an active signup for this session.",
        ],
      });
    case QueueErrorCode.INVALID_EMAIL:
      return errorState(values, null, {
        email: ["Enter a valid student email address."],
      });
    case QueueErrorCode.INVALID_PHONE:
      return errorState(values, null, {
        phone: ["Enter a valid phone number."],
      });
    case QueueErrorCode.INVALID_STUDENT_INPUT:
      return errorState(
        values,
        "Please review your information and try again.",
      );
    default:
      return errorState(values, UNEXPECTED_MESSAGE);
  }
}

export async function getStudentSignupAvailability(
  client: StudentSignupDatabaseClient,
  sessionCodeInput: unknown,
): Promise<StudentSignupAvailability> {
  const code = studentSessionCodeSchema.safeParse(sessionCodeInput);
  if (!code.success) {
    return { available: false, message: INVALID_LINK_MESSAGE };
  }

  try {
    const session = await findSignupSession(client, code.data);
    if (!session) {
      return { available: false, message: INVALID_LINK_MESSAGE };
    }
    if (session.status !== "ACTIVE") {
      return { available: false, message: INACTIVE_SESSION_MESSAGE };
    }
    return { available: true, sessionCode: code.data };
  } catch {
    return {
      available: false,
      message:
        "We could not check this signup session right now. Please try again.",
    };
  }
}

/** Authoritative server operation used by the student signup Server Action. */
export async function executeStudentSignup(
  client: StudentSignupDatabaseClient,
  sessionCodeInput: unknown,
  input: {
    fullName?: unknown;
    pantherId?: unknown;
    email?: unknown;
    phone?: unknown;
  },
): Promise<StudentSignupState> {
  const values = preserveStudentSignupValues(input);
  const code = studentSessionCodeSchema.safeParse(sessionCodeInput);
  if (!code.success) {
    return errorState(values, INVALID_LINK_MESSAGE);
  }

  const student = joinQueueSchema.safeParse(input);
  if (!student.success) {
    return errorState(
      values,
      null,
      student.error.flatten().fieldErrors as StudentSignupFieldErrors,
    );
  }

  try {
    const session = await findSignupSession(client, code.data);
    if (!session) {
      return errorState(values, INVALID_LINK_MESSAGE);
    }
    if (session.status !== "ACTIVE") {
      return errorState(values, INACTIVE_SESSION_MESSAGE);
    }

    return {
      status: "success",
      result: await joinQueue(client, session.id, student.data),
    };
  } catch (error) {
    if (error instanceof QueueOperationError) {
      return mapQueueError(error, values);
    }
    return errorState(values, UNEXPECTED_MESSAGE);
  }
}
