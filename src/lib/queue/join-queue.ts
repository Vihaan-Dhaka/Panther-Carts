import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseQueueErrorCode, QueueOperationError } from "@/lib/queue/errors";
import {
  joinQueueRpcResponseSchema,
  signupSessionRowSchema,
  type JoinQueueValues,
} from "@/lib/validation/student";

export type StudentSignupDatabaseClient = Pick<SupabaseClient, "from" | "rpc">;

export type SignupSession = {
  id: string;
  status: "DRAFT" | "ACTIVE" | "CLOSED";
};

export type JoinQueueResult =
  | { status: "READY"; pickupCode: string }
  | {
      status: "WAITING";
      position: number;
      estimatedWaitMinutes: number | null;
    };

/** Resolve a public student code for a trusted server operation. */
export async function findSignupSession(
  client: StudentSignupDatabaseClient,
  sessionCode: string,
): Promise<SignupSession | null> {
  const { data, error } = await client
    .from("sessions")
    .select("id,status")
    .eq("student_code", sessionCode)
    .maybeSingle();

  if (error) {
    throw new QueueOperationError(null);
  }

  if (data === null) {
    return null;
  }

  const parsed = signupSessionRowSchema.safeParse(data);
  if (!parsed.success) {
    throw new QueueOperationError(null);
  }

  return parsed.data;
}

/** Thin typed wrapper around the authoritative PostgreSQL join_queue RPC. */
export async function joinQueue(
  client: StudentSignupDatabaseClient,
  sessionId: string,
  student: JoinQueueValues,
): Promise<JoinQueueResult> {
  const { data, error } = await client.rpc("join_queue", {
    p_session_id: sessionId,
    p_full_name: student.fullName,
    p_panther_id: student.pantherId,
    p_email: student.email,
    p_phone: student.phone,
    p_sms_consent: student.smsConsent,
  });

  if (error) {
    throw new QueueOperationError(parseQueueErrorCode(error.message));
  }

  const parsed = joinQueueRpcResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new QueueOperationError(null);
  }

  const result = parsed.data;
  if (result.queue_entry.status === "READY") {
    return {
      status: "READY",
      pickupCode: result.queue_entry.pickup_code,
    };
  }

  return {
    status: "WAITING",
    position: result.position,
    estimatedWaitMinutes: result.estimated_wait_minutes,
  };
}
