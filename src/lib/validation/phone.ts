/**
 * Phone normalization — deterministic TypeScript mirror of the SQL function
 * `public.normalize_phone`. Kept in sync so the server layer and the database
 * agree on the canonical form used for the "one active entry per phone per
 * session" invariant.
 *
 * US-centric by documented assumption: a bare 10-digit number is treated as a
 * US number and prefixed with +1. Any other digit count is preserved with a
 * leading '+'. This is intentionally simple; richer parsing (e.g. libphonenumber)
 * can replace it later without changing the contract.
 */
export function normalizePhone(input: string | null | undefined): string {
  if (input == null) {
    return "";
  }
  const digits = input.replace(/[^0-9]/g, "");
  if (digits === "") {
    return "";
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return `+${digits}`;
}
