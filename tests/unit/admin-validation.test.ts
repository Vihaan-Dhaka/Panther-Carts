import { describe, expect, it } from "vitest";
import {
  adminBinMutationSchema,
  adminNotifySchema,
  adminSessionConfigurationSchema,
  adminSessionCreationSchema,
  adminViewKeySchema,
} from "@/lib/validation/admin";

const KEY = "7b830507-034f-4746-9a67-f7e9184d40bc";

describe("admin validation", () => {
  it("validates session creation and positive duration bounds", () => {
    expect(
      adminSessionCreationSchema.parse({
        name: "  Fall service  ",
        rentalDurationMinutes: "60",
        pickupWindowMinutes: "10",
        idempotencyKey: KEY,
      }),
    ).toEqual({
      name: "Fall service",
      rentalDurationMinutes: 60,
      pickupWindowMinutes: 10,
      idempotencyKey: KEY,
    });
    expect(
      adminSessionConfigurationSchema.safeParse({
        rentalDurationMinutes: "0",
        pickupWindowMinutes: "10.5",
      }).success,
    ).toBe(false);
  });

  it("normalizes an individual numbered bin", () => {
    expect(
      adminBinMutationSchema.parse({ mode: "single", binNumber: " 00042 " }),
    ).toEqual({ mode: "single", binNumbers: ["42"], duplicateInputs: [] });
  });

  it("expands a bounded inclusive range", () => {
    expect(
      adminBinMutationSchema.parse({
        mode: "range",
        rangeStart: "008",
        rangeEnd: "10",
      }),
    ).toEqual({
      mode: "range",
      binNumbers: ["8", "9", "10"],
      duplicateInputs: [],
    });
    expect(
      adminBinMutationSchema.safeParse({
        mode: "range",
        rangeStart: "10",
        rangeEnd: "8",
      }).success,
    ).toBe(false);
  });

  it("normalizes pasted delimiters and reports repeated normalized numbers", () => {
    expect(
      adminBinMutationSchema.parse({
        mode: "paste",
        pastedBins: "001, 2;\n0001 3",
      }),
    ).toEqual({
      mode: "paste",
      binNumbers: ["1", "2", "3"],
      duplicateInputs: ["1"],
    });
  });

  it.each(["abc", "0", "-2", "1000000"])(
    "rejects invalid pasted bin token %s",
    (token) => {
      const result = adminBinMutationSchema.safeParse({
        mode: "paste",
        pastedBins: `1, ${token}, 2`,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes(token)),
        ).toBe(true);
      }
    },
  );

  it("validates notification references and all seven exact view keys", () => {
    expect(
      adminNotifySchema.safeParse({
        rentalId: "not-an-id",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
    expect(
      [
        "overview",
        "current-late",
        "all-late",
        "checked-out",
        "inventory",
        "rentals",
        "waitlist",
      ].every((value) => adminViewKeySchema.safeParse(value).success),
    ).toBe(true);
    expect(adminViewKeySchema.safeParse("notifications").success).toBe(false);
  });
});
