import "server-only";

import { adminUserSchema } from "@/lib/validation/auth";
import { createClient } from "@/lib/supabase/server";

export class AuthorizationError extends Error {
  constructor() {
    super("Authorization required");
    this.name = "AuthorizationError";
  }
}

export type AdminIdentity = { userId: string };

export async function requireAdmin(): Promise<AdminIdentity> {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new AuthorizationError();
  const parsed = adminUserSchema.safeParse(data.user);
  if (!parsed.success || parsed.data.app_metadata.role !== "admin") {
    throw new AuthorizationError();
  }
  return { userId: parsed.data.id };
}
