import { z } from "zod";

function formString<T extends z.ZodType<string>>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    schema,
  );
}

export const adminLoginSchema = z.object({
  email: formString(
    z.email("Enter a valid email address").trim().toLowerCase().max(320),
  ),
  password: formString(
    z.string().min(1, "Password is required").max(1_024, "Password is invalid"),
  ),
});

export const adminUserSchema = z.object({
  id: z.uuid(),
  app_metadata: z.record(z.string(), z.unknown()),
});

export const staffLinkTokenSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z
    .string()
    .trim()
    .min(32)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
);

export const staffManualAccessCodeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z
    .string()
    .trim()
    .regex(/^\d{8}$/, "Enter the eight-digit staff access code"),
);

export const staffSessionCookieSchema = z
  .string()
  .min(40)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export const staffWebSessionRpcSchema = z.object({
  session_id: z.uuid(),
  expires_at: z.string().datetime({ offset: true }),
});

export const staffWebSessionRowSchema = z.object({
  session_id: z.uuid(),
  expires_at: z.string().datetime({ offset: true }),
  revoked_at: z.string().datetime({ offset: true }).nullable(),
});

export const protectedStaffSessionRowSchema = z.object({
  id: z.uuid(),
  status: z.literal("ACTIVE"),
});

export const rateLimitRpcSchema = z.object({
  allowed: z.boolean(),
  remaining: z.number().int().nonnegative(),
  retry_after_seconds: z.number().int().nonnegative(),
});
