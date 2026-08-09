import { describe, expect, it } from "vitest";
import { estimateWaitMinutes } from "@/lib/queue/estimated-wait";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("estimateWaitMinutes", () => {
  it("returns unavailable when there are no active rentals", () => {
    expect(
      estimateWaitMinutes({
        activeDueTimes: [],
        rentalDurationMinutes: 60,
        position: 1,
        now: NOW,
      }),
    ).toEqual({ available: false });
  });

  it("returns unavailable for non-positive or non-integer positions", () => {
    const base = {
      activeDueTimes: [minutesFromNow(10)],
      rentalDurationMinutes: 60,
      now: NOW,
    };
    expect(estimateWaitMinutes({ ...base, position: 0 })).toEqual({
      available: false,
    });
    expect(estimateWaitMinutes({ ...base, position: -3 })).toEqual({
      available: false,
    });
    expect(estimateWaitMinutes({ ...base, position: 1.5 })).toEqual({
      available: false,
    });
  });

  it("maps positions to sorted due times within the first cycle", () => {
    // Provided out of order to prove the function sorts ascending.
    const activeDueTimes = [minutesFromNow(40), minutesFromNow(10)];
    const base = { activeDueTimes, rentalDurationMinutes: 60, now: NOW };

    expect(estimateWaitMinutes({ ...base, position: 1 })).toEqual({
      available: true,
      minutes: 10,
    });
    expect(estimateWaitMinutes({ ...base, position: 2 })).toEqual({
      available: true,
      minutes: 40,
    });
  });

  it("adds a rental-duration cycle beyond one full bin cycle", () => {
    const activeDueTimes = [minutesFromNow(10), minutesFromNow(40)];
    const base = { activeDueTimes, rentalDurationMinutes: 60, now: NOW };

    // n = 2, duration = 60.
    expect(estimateWaitMinutes({ ...base, position: 3 })).toEqual({
      available: true,
      minutes: 70, // 10 + 60
    });
    expect(estimateWaitMinutes({ ...base, position: 4 })).toEqual({
      available: true,
      minutes: 100, // 40 + 60
    });
    expect(estimateWaitMinutes({ ...base, position: 5 })).toEqual({
      available: true,
      minutes: 130, // 10 + 120
    });
  });

  it("treats an overdue rental as zero remaining minutes in its current cycle", () => {
    const activeDueTimes = [minutesFromNow(-15)]; // already overdue
    const base = { activeDueTimes, rentalDurationMinutes: 60, now: NOW };

    // Current cycle: clamped to zero.
    expect(estimateWaitMinutes({ ...base, position: 1 })).toEqual({
      available: true,
      minutes: 0,
    });
    // Next cycle still counts: -15 + 60 = 45 minutes from now.
    expect(estimateWaitMinutes({ ...base, position: 2 })).toEqual({
      available: true,
      minutes: 45,
    });
  });

  it("takes the non-negative ceiling of the remaining minutes", () => {
    const activeDueTimes = [new Date(NOW.getTime() + 10 * 60_000 + 1_000)];
    const result = estimateWaitMinutes({
      activeDueTimes,
      rentalDurationMinutes: 60,
      position: 1,
      now: NOW,
    });
    expect(result).toEqual({ available: true, minutes: 11 });
  });
});
