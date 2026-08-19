import "server-only";

import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { credentialVerifier } from "./credentials";
import { rateLimitRpcSchema } from "@/lib/validation/auth";

export const RATE_LIMITS = {
  admin_login: { limit: 5, windowSeconds: 15 * 60 },
  admin_operation: { limit: 120, windowSeconds: 60 },
  staff_link_exchange: { limit: 20, windowSeconds: 15 * 60 },
  staff_code_exchange: { limit: 5, windowSeconds: 15 * 60 },
  staff_operation: { limit: 120, windowSeconds: 60 },
  student_code_check: { limit: 60, windowSeconds: 10 * 60 },
  student_signup: { limit: 5, windowSeconds: 10 * 60 },
} as const;

export type RateLimitScope = keyof typeof RATE_LIMITS;
export type RateLimitDatabaseClient = Pick<SupabaseClient, "rpc">;

const forwardedHeaderSchema = z.string().trim().min(1).max(512);

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function requestIp(requestHeaders: Headers): string {
  for (const name of ["x-vercel-forwarded-for", "x-forwarded-for"] as const) {
    const raw = requestHeaders.get(name);
    const parsed = forwardedHeaderSchema.safeParse(raw);
    if (!parsed.success) continue;
    const candidate = parsed.data.split(",", 1)[0]?.trim() ?? "";
    if (isIP(candidate) !== 0) return candidate;
  }
  return "unknown";
}

export function rateLimitIdentity(...stableParts: string[]): string {
  const normalized = stableParts.map((part) => part.trim().toLowerCase());
  return credentialVerifier(`rate-limit\u0000${normalized.join("\u0000")}`);
}

export async function consumeRateLimit(
  client: RateLimitDatabaseClient,
  scope: RateLimitScope,
  ...identityParts: string[]
): Promise<RateLimitResult> {
  const settings = RATE_LIMITS[scope];
  const { data, error } = await client.rpc("consume_rate_limit", {
    p_scope: scope,
    p_identity_hash: rateLimitIdentity(...identityParts),
    p_limit: settings.limit,
    p_window_seconds: settings.windowSeconds,
  });
  if (error) throw new Error("Rate limit unavailable");
  const parsed = rateLimitRpcSchema.safeParse(data);
  if (!parsed.success) throw new Error("Rate limit unavailable");
  return {
    allowed: parsed.data.allowed,
    remaining: parsed.data.remaining,
    retryAfterSeconds: parsed.data.retry_after_seconds,
  };
}
