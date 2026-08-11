import { z } from "zod";

function formString(schema: z.ZodString) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    schema,
  );
}

export const staffAccessCodeSchema = formString(
  z
    .string()
    .trim()
    .min(1, "Staff link is required")
    .max(200, "Staff link is invalid"),
);

export const pickupCodeSchema = formString(
  z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Enter the student’s four-digit pickup code"),
);

export const binNumberSchema = formString(
  z
    .string()
    .trim()
    .min(1, "Bin number is required")
    .max(200, "Bin number is invalid"),
);

export const idempotencyKeySchema = formString(
  z.string().trim().uuid("This confirmation expired. Look up the rental again"),
);

const checkedConfirmationSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value : ""),
    z.literal("on", {
      error: "Confirm the PantherCard handoff before continuing",
    }),
  )
  .transform(() => true as const);

export const checkoutLookupSchema = z.object({
  pickupCode: pickupCodeSchema,
});

export const checkoutConfirmationSchema = z.object({
  binNumber: binNumberSchema,
  pantherCardCollected: checkedConfirmationSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const returnLookupSchema = z.object({
  binNumber: binNumberSchema,
});

export const returnConfirmationSchema = z.object({
  binNumber: binNumberSchema,
  pantherCardReturned: checkedConfirmationSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const staffSessionRowSchema = z.object({
  id: z.uuid(),
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]),
});

export const checkoutQueueEntryRowSchema = z.object({
  id: z.uuid(),
  student_id: z.uuid(),
  reserved_bin_id: z.uuid(),
  pickup_expires_at: z.string().datetime({ offset: true }),
  status: z.literal("READY"),
});

export const activeReservationRowSchema = z.object({
  bin_id: z.uuid(),
  status: z.literal("ACTIVE"),
  expires_at: z.string().datetime({ offset: true }),
});

export const publicStudentRowSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  panther_id: z.string().trim().min(1).max(50),
});

export const staffBinRowSchema = z.object({
  id: z.uuid(),
  bin_number: z.string().max(200),
  status: z.enum(["AVAILABLE", "RESERVED", "OUT"]),
});

export const activeRentalLookupRowSchema = z.object({
  student_id: z.uuid(),
  status: z.literal("OUT"),
});

export const checkoutRpcResponseSchema = z.object({
  rental: z.object({
    session_id: z.uuid(),
    bin_id: z.uuid(),
    student_id: z.uuid(),
    status: z.literal("OUT"),
    due_at: z.string().datetime({ offset: true }),
    panthercard_collected_at: z.string().datetime({ offset: true }),
    checkout_idempotency_key: z.uuid(),
  }),
  swapped: z.boolean(),
  idempotent_replay: z.boolean(),
});

export const returnRpcResponseSchema = z.object({
  rental: z.object({
    session_id: z.uuid(),
    bin_id: z.uuid(),
    student_id: z.uuid(),
    status: z.literal("RETURNED"),
    was_late: z.boolean(),
    panthercard_returned_at: z.string().datetime({ offset: true }),
    return_idempotency_key: z.uuid(),
  }),
  reservation: z
    .object({
      id: z.uuid(),
      queue_entry_id: z.uuid(),
      bin_id: z.uuid(),
      status: z.literal("ACTIVE"),
      expires_at: z.string().datetime({ offset: true }),
    })
    .nullable(),
  idempotent_replay: z.boolean(),
});

export type CheckoutConfirmationValues = z.output<
  typeof checkoutConfirmationSchema
>;
export type ReturnConfirmationValues = z.output<
  typeof returnConfirmationSchema
>;
