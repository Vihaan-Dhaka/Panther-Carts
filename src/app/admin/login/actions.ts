"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { adminLoginSchema, adminUserSchema } from "@/lib/validation/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { consumeRateLimit, requestIp } from "@/lib/auth/rate-limit";

export type AdminLoginState = {
  status: "idle" | "error";
  fieldErrors: Partial<Record<"email" | "password", string[]>>;
  formError: string | null;
};

const INVALID_LOGIN =
  "Sign-in was not accepted. Check your credentials or try again later.";

export async function loginAdminAction(
  _previousState: AdminLoginState,
  formData: FormData,
): Promise<AdminLoginState> {
  const input = {
    email: formData.get("email"),
    password: formData.get("password"),
  };
  const parsed = adminLoginSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      fieldErrors: parsed.error.flatten().fieldErrors,
      formError: null,
    };
  }

  try {
    const limit = await consumeRateLimit(
      createAdminClient(),
      "admin_login",
      requestIp(await headers()),
      parsed.data.email,
    );
    if (!limit.allowed) {
      return { status: "error", fieldErrors: {}, formError: INVALID_LOGIN };
    }

    const client = await createClient();
    const { error } = await client.auth.signInWithPassword(parsed.data);
    if (error) {
      return { status: "error", fieldErrors: {}, formError: INVALID_LOGIN };
    }
    const { data, error: userError } = await client.auth.getUser();
    const user = adminUserSchema.safeParse(data.user);
    if (userError || !user.success || user.data.app_metadata.role !== "admin") {
      await client.auth.signOut();
      return { status: "error", fieldErrors: {}, formError: INVALID_LOGIN };
    }
  } catch {
    return { status: "error", fieldErrors: {}, formError: INVALID_LOGIN };
  }

  redirect("/admin");
}
