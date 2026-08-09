import { z } from "zod";
import { normalizePhone } from "./phone";

/**
 * Validation for student signup / join-queue input. Server operations validate
 * external input with this schema (per the architecture rules) before calling
 * the `join_queue` RPC. The database performs the same normalization
 * defensively, so the two layers agree on the canonical phone form.
 */
export const joinQueueSchema = z
  .object({
    fullName: z.string().trim().min(1, "Full name is required").max(200),
    pantherId: z.string().trim().min(1, "Panther ID is required").max(50),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("A valid email is required")
      .max(320),
    phone: z.string().trim().min(1, "Phone number is required"),
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
