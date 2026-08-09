/**
 * Estimated-wait calculation — deterministic TypeScript mirror of the
 * authoritative SQL function `public.estimated_wait_minutes` (see
 * supabase/migrations and docs/DATABASE.md).
 *
 * The estimate is informational only. It never influences queue order.
 *
 * Algorithm
 * ---------
 * For every active OUT rental, `expected_return_at = due_at`. Sort those due
 * times ascending with a stable tie-breaker. For a waiting student at 1-based
 * position `p` with `n` active OUT rentals:
 *
 *   cycle = floor((p - 1) / n)
 *   index = (p - 1) mod n
 *   minutes = max(0, ceil((sorted_due_times[index] - now) / 60s))
 *             + cycle * rental_duration
 *
 * The current cycle's remaining time is clamped to zero *before* whole
 * rental-duration cycles are added, so an overdue rental contributes zero
 * remaining minutes for its own cycle without erasing the later cycles a
 * student further back must still wait through. (Adding cycles to a historical
 * due timestamp and clamping afterwards reports 0 for every position behind a
 * long-overdue rental.)
 *
 * If there are no active rentals, the estimate is unavailable — we return a
 * typed result rather than inventing a time.
 */

export type WaitEstimate =
  { available: true; minutes: number } | { available: false };

export interface EstimateWaitInput {
  /** Due timestamps of every active OUT rental (any order). */
  activeDueTimes: Date[];
  /** Session rental duration in minutes. */
  rentalDurationMinutes: number;
  /** 1-based queue position of the waiting student. */
  position: number;
  /** Reference "database time". */
  now: Date;
}

const MS_PER_MINUTE = 60_000;

export function estimateWaitMinutes(input: EstimateWaitInput): WaitEstimate {
  const { activeDueTimes, rentalDurationMinutes, position, now } = input;

  if (!Number.isInteger(position) || position < 1) {
    return { available: false };
  }

  const n = activeDueTimes.length;
  if (n === 0) {
    return { available: false };
  }

  // Sort ascending by time. Array.prototype.sort is stable, matching the SQL
  // (due_at asc, id asc) tie-breaker for equal due times.
  const sorted = [...activeDueTimes].sort((a, b) => a.getTime() - b.getTime());

  const cycle = Math.floor((position - 1) / n);
  const index = (position - 1) % n;

  const currentCycleMinutes = Math.max(
    0,
    Math.ceil((sorted[index].getTime() - now.getTime()) / MS_PER_MINUTE),
  );
  const minutes = currentCycleMinutes + cycle * rentalDurationMinutes;

  return { available: true, minutes };
}
