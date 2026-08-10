import { z } from "zod";
import { normalizePhone } from "./phone";

function formString(schema: z.ZodString) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    schema,
  );
}

export const studentSessionCodeSchema = formString(
  z
    .string()
    .trim()
    .min(1, "Signup link is required")
    .max(200, "Signup link is invalid"),
);

/**
 * Validation for student signup / join-queue input. Server operations validate
 * external input with this schema (per the architecture rules) before calling
 * the `join_queue` RPC. The database performs the same normalization
 * defensively, so the two layers agree on the canonical phone form.
 */
export const joinQueueSchema = z
  .object({
    fullName: formString(
      z
        .string()
        .trim()
        .min(1, "Full name is required")
        .max(200, "Full name must be 200 characters or fewer"),
    ),
    pantherId: formString(
      z
        .string()
        .trim()
        .min(1, "Panther ID is required")
        .max(50, "Panther ID must be 50 characters or fewer"),
    ),
    email: formString(
      z
        .string()
        .trim()
        .toLowerCase()
        .email("A valid email is required")
        .max(320, "Email must be 320 characters or fewer"),
    ),
    phone: formString(z.string().trim().min(1, "Phone number is required")),
  })
  .transform((value) => ({
    ...value,
    phone: normalizePhone(value.phone),
  }))
  .refine((value) => /^\+\d{10,15}$/.test(value.phone), {
    message: "A valid phone number is required",
    path: ["phone"],
  });

export type JoinQueueInput = z.input<typeof joinQueueSchema>;
export type JoinQueueValues = z.output<typeof joinQueueSchema>;

export const signupSessionRowSchema = z.object({
  id: z.uuid(),
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]),
});

const readyQueueEntrySchema = z.object({
  status: z.literal("READY"),
  pickup_code: z.string().regex(/^\d{4}$/),
});

const waitingQueueEntrySchema = z.object({
  status: z.literal("WAITING"),
  pickup_code: z.null().optional(),
});

export const joinQueueRpcResponseSchema = z
  .object({
    queue_entry: z.discriminatedUnion("status", [
      readyQueueEntrySchema,
      waitingQueueEntrySchema,
    ]),
    position: z.number().int().nonnegative(),
    estimated_wait_minutes: z.number().int().nonnegative().nullable(),
  })
  .superRefine((value, context) => {
    if (value.queue_entry.status === "READY" && value.position !== 0) {
      context.addIssue({
        code: "custom",
        message: "A ready queue entry must have position zero",
        path: ["position"],
      });
    }

    if (value.queue_entry.status === "WAITING" && value.position < 1) {
      context.addIssue({
        code: "custom",
        message: "A waiting queue entry must have a positive position",
        path: ["position"],
      });
    }
  });
