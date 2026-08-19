import { z } from "zod";
import { ADMIN_VIEW_OPTIONS } from "@/lib/admin/types";

function formString<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    schema,
  );
}

const positiveMinutes = (label: string, maximum: number) =>
  formString(
    z
      .string()
      .trim()
      .regex(/^\d+$/, `${label} must be a whole number`)
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .min(1, `${label} must be at least 1 minute`)
          .max(maximum, `${label} must be ${maximum} minutes or fewer`),
      ),
  );

export const adminSessionConfigurationSchema = z.object({
  rentalDurationMinutes: positiveMinutes("Rental duration", 1_440),
  pickupWindowMinutes: positiveMinutes("Pickup window", 240),
});

export const adminSessionCreationSchema = z.object({
  name: formString(
    z
      .string()
      .trim()
      .min(1, "Session name is required")
      .max(120, "Session name must be 120 characters or fewer"),
  ),
  rentalDurationMinutes: positiveMinutes("Rental duration", 1_440),
  pickupWindowMinutes: positiveMinutes("Pickup window", 240),
  idempotencyKey: formString(
    z
      .string()
      .trim()
      .uuid("Refresh the page and try creating the session again"),
  ),
});

export const adminSessionIdSchema = z.uuid();

export const adminMutationIdempotencyKeySchema = formString(
  z.string().trim().uuid("Refresh the page and try again"),
);

const normalizedBinNumber = formString(
  z
    .string()
    .trim()
    .regex(/^\d+$/, "Use digits only")
    .transform((value) => value.replace(/^0+(?=\d)/, ""))
    .refine((value) => value !== "0", "Bin numbers must be at least 1")
    .refine(
      (value) => value.length <= 6,
      "Bin numbers must be 999999 or lower",
    ),
);

export const adminSingleBinSchema = z.object({
  mode: z.literal("single"),
  binNumber: normalizedBinNumber,
});

export const adminRangeBinSchema = z
  .object({
    mode: z.literal("range"),
    rangeStart: normalizedBinNumber,
    rangeEnd: normalizedBinNumber,
  })
  .superRefine((value, context) => {
    const start = Number(value.rangeStart);
    const end = Number(value.rangeEnd);
    if (end < start) {
      context.addIssue({
        code: "custom",
        path: ["rangeEnd"],
        message: "Range end must be greater than or equal to range start",
      });
    } else if (end - start + 1 > 500) {
      context.addIssue({
        code: "custom",
        path: ["rangeEnd"],
        message: "Add at most 500 bins in one range",
      });
    }
  })
  .transform((value) => ({
    mode: value.mode,
    binNumbers: Array.from(
      { length: Number(value.rangeEnd) - Number(value.rangeStart) + 1 },
      (_, index) => String(Number(value.rangeStart) + index),
    ),
    duplicateInputs: [] as string[],
  }));

const pastedTokenSchema = normalizedBinNumber;

export const adminPastedBinsSchema = z
  .object({
    mode: z.literal("paste"),
    pastedBins: formString(
      z
        .string()
        .trim()
        .min(1, "Paste at least one bin number")
        .max(20_000, "The pasted list is too long"),
    ),
  })
  .transform((value, context) => {
    const tokens = value.pastedBins.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length > 500) {
      context.addIssue({
        code: "custom",
        path: ["pastedBins"],
        message: "Add at most 500 bins at a time",
      });
      return z.NEVER;
    }

    const valid: string[] = [];
    const invalid: string[] = [];
    for (const token of tokens) {
      const parsed = pastedTokenSchema.safeParse(token);
      if (parsed.success) valid.push(parsed.data);
      else invalid.push(token);
    }
    if (invalid.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["pastedBins"],
        message: `Invalid bin number${invalid.length === 1 ? "" : "s"}: ${invalid
          .slice(0, 5)
          .join(", ")}${invalid.length > 5 ? ", …" : ""}`,
      });
      return z.NEVER;
    }

    const seen = new Set<string>();
    const binNumbers: string[] = [];
    const duplicateInputs: string[] = [];
    for (const binNumber of valid) {
      if (seen.has(binNumber)) duplicateInputs.push(binNumber);
      else {
        seen.add(binNumber);
        binNumbers.push(binNumber);
      }
    }
    return { mode: value.mode, binNumbers, duplicateInputs };
  });

export const adminBinMutationSchema = z.discriminatedUnion("mode", [
  adminSingleBinSchema.transform((value) => ({
    mode: value.mode,
    binNumbers: [value.binNumber],
    duplicateInputs: [] as string[],
  })),
  adminRangeBinSchema,
  adminPastedBinsSchema,
]);

export const adminNotifySchema = z.object({
  rentalId: formString(z.string().trim().uuid("That rental is invalid")),
  idempotencyKey: adminMutationIdempotencyKeySchema,
});

export const adminViewKeySchema = z.enum(
  ADMIN_VIEW_OPTIONS.map(([value]) => value) as [
    (typeof ADMIN_VIEW_OPTIONS)[number][0],
    ...(typeof ADMIN_VIEW_OPTIONS)[number][0][],
  ],
);

export const adminSessionRowSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]),
  student_code: z.string().trim().min(1).max(200),
  staff_code: z.string().trim().min(1).max(2_048),
  staff_access_code_ciphertext: z.string().min(1).max(2_048).nullable(),
  staff_credential_version: z.enum(["legacy-sha256", "hmac-v1"]),
  rental_duration_minutes: z.number().int().positive(),
  pickup_window_minutes: z.number().int().positive(),
  created_at: z.string().datetime({ offset: true }),
  started_at: z.string().datetime({ offset: true }).nullable(),
  ended_at: z.string().datetime({ offset: true }).nullable(),
});

const studentProjection = {
  full_name: z.string().trim().min(1).max(200),
  panther_id: z.string().trim().min(1).max(50),
  email: z.string().email().max(320),
  phone: z.string().regex(/^\+\d{10,15}$/),
};

export const currentOutRentalRowSchema = z.object({
  rental_id: z.uuid(),
  session_id: z.uuid(),
  bin_number: z.string().min(1).max(200),
  ...studentProjection,
  checked_out_at: z.string().datetime({ offset: true }),
  due_at: z.string().datetime({ offset: true }),
  is_currently_late: z.boolean(),
});

export const currentLateRentalRowSchema = z.object({
  rental_id: z.uuid(),
  session_id: z.uuid(),
  bin_number: z.string().min(1).max(200),
  ...studentProjection,
  checked_out_at: z.string().datetime({ offset: true }),
  due_at: z.string().datetime({ offset: true }),
});

export const historicalRentalRowSchema = z.object({
  rental_id: z.uuid(),
  session_id: z.uuid(),
  bin_number: z.string().min(1).max(200),
  ...studentProjection,
  status: z.enum(["OUT", "RETURNED"]),
  checked_out_at: z.string().datetime({ offset: true }),
  due_at: z.string().datetime({ offset: true }),
  returned_at: z.string().datetime({ offset: true }).nullable(),
  was_late: z.boolean(),
  is_currently_late: z.boolean(),
});

export const inventoryRowSchema = z.object({
  session_id: z.uuid(),
  bin_number: z.string().min(1).max(200),
  status: z.enum(["AVAILABLE", "RESERVED", "OUT"]),
  current_rental_id: z.uuid().nullable(),
  current_checked_out_at: z.string().datetime({ offset: true }).nullable(),
  current_due_at: z.string().datetime({ offset: true }).nullable(),
  is_currently_late: z.boolean(),
  current_full_name: studentProjection.full_name.nullable(),
  current_panther_id: studentProjection.panther_id.nullable(),
  current_email: studentProjection.email.nullable(),
  current_phone: studentProjection.phone.nullable(),
});

export const waitlistRowSchema = z.object({
  queue_entry_id: z.uuid(),
  session_id: z.uuid(),
  queue_rank: z.number().int().positive(),
  joined_at: z.string().datetime({ offset: true }),
  phone: studentProjection.phone,
  full_name: studentProjection.full_name,
  panther_id: studentProjection.panther_id,
  email: studentProjection.email,
});

export const adminSessionRpcResponseSchema = z.object({
  session: adminSessionRowSchema,
  idempotent_replay: z.boolean(),
});

export const adminBinsRpcResponseSchema = z.object({
  added: z.array(z.string().regex(/^[1-9]\d{0,5}$/)),
  duplicates: z.array(z.string().regex(/^[1-9]\d{0,5}$/)),
});

export const adminNotifyRpcResponseSchema = z.object({
  outbox_id: z.uuid(),
  body: z.string().min(1).max(2_000),
  idempotent_replay: z.boolean(),
});
