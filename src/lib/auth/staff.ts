import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import {
  credentialVerifier,
  generateStaffSessionToken,
  legacyCredentialVerifier,
} from "./credentials";
import { AuthorizationError } from "./admin";
import {
  protectedStaffSessionRowSchema,
  staffLinkTokenSchema,
  staffManualAccessCodeSchema,
  staffSessionCookieSchema,
  staffWebSessionRowSchema,
  staffWebSessionRpcSchema,
} from "@/lib/validation/auth";

export const STAFF_SESSION_COOKIE = "panther_staff_session";
export const STAFF_SESSION_SECONDS = 12 * 60 * 60;

export type StaffAuthDatabaseClient = Pick<SupabaseClient, "from" | "rpc">;
export type StaffAuthorization = {
  sessionId: string;
  tokenHash: string;
};

export type StaffCredentialExchange = {
  sessionId: string;
  token: string;
  expiresAt: Date;
};

function databaseFailure(): Error {
  return new Error("Staff authorization unavailable");
}

export async function exchangeStaffCredential(
  client: StaffAuthDatabaseClient,
  kind: "link" | "code",
  credentialInput: unknown,
): Promise<StaffCredentialExchange | null> {
  const schema =
    kind === "link" ? staffLinkTokenSchema : staffManualAccessCodeSchema;
  const credential = schema.safeParse(credentialInput);
  if (!credential.success) return null;

  const token = generateStaffSessionToken();
  const tokenHash = credentialVerifier(token);
  const expiresAt = new Date(Date.now() + STAFF_SESSION_SECONDS * 1_000);
  const { data, error } = await client.rpc("create_staff_web_session", {
    p_candidate_hashes: [
      credentialVerifier(credential.data),
      legacyCredentialVerifier(credential.data),
    ],
    p_session_token_hash: tokenHash,
    p_expires_at: expiresAt.toISOString(),
  });
  if (error) return null;
  const parsed = staffWebSessionRpcSchema.safeParse(data);
  if (!parsed.success) throw databaseFailure();
  const returnedExpiresAt = new Date(parsed.data.expires_at);
  if (returnedExpiresAt.getTime() !== expiresAt.getTime()) {
    throw databaseFailure();
  }
  return {
    sessionId: parsed.data.session_id,
    token,
    expiresAt: returnedExpiresAt,
  };
}

export async function resolveStaffSession(
  client: StaffAuthDatabaseClient,
  tokenInput: unknown,
): Promise<StaffAuthorization | null> {
  const token = staffSessionCookieSchema.safeParse(tokenInput);
  if (!token.success) return null;
  const tokenHash = credentialVerifier(token.data);
  const { data: webSessionData, error: webSessionError } = await client
    .from("staff_web_sessions")
    .select("session_id,expires_at,revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (webSessionError) throw databaseFailure();
  if (webSessionData === null) return null;
  const webSession = staffWebSessionRowSchema.safeParse(webSessionData);
  if (!webSession.success) throw databaseFailure();
  if (
    webSession.data.revoked_at !== null ||
    new Date(webSession.data.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  const { data: sessionData, error: sessionError } = await client
    .from("sessions")
    .select("id,status")
    .eq("id", webSession.data.session_id)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (sessionError) throw databaseFailure();
  if (sessionData === null) return null;
  const session = protectedStaffSessionRowSchema.safeParse(sessionData);
  if (!session.success || session.data.id !== webSession.data.session_id) {
    throw databaseFailure();
  }
  return { sessionId: session.data.id, tokenHash };
}

export async function requireStaffSession(
  client: StaffAuthDatabaseClient,
): Promise<StaffAuthorization> {
  const token = (await cookies()).get(STAFF_SESSION_COOKIE)?.value;
  const authorization = await resolveStaffSession(client, token);
  if (!authorization) throw new AuthorizationError();
  return authorization;
}

export const staffSessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/staff",
  maxAge: STAFF_SESSION_SECONDS,
  priority: "high" as const,
};
