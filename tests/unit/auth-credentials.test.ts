import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  credentialVerifier,
  decryptCredential,
  encryptCredential,
  generateStaffAccessCode,
  generateStaffLinkToken,
  generateStaffSessionToken,
  generateStudentSessionCode,
} from "@/lib/auth/credentials";

beforeEach(() => {
  vi.stubEnv(
    "PANTHER_AUTH_SECRET",
    "test-only-auth-secret-that-is-longer-than-thirty-two-characters",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("protected authentication credentials", () => {
  it("round-trips authenticated ciphertext without retaining plaintext", () => {
    const plaintext = "staff-link-secret-value";
    const ciphertext = encryptCredential(plaintext);
    expect(ciphertext).toMatch(/^v1\./);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptCredential(ciphertext)).toBe(plaintext);
  });

  it("rejects tampered ciphertext and changes verifiers when the server secret changes", () => {
    const ciphertext = encryptCredential("protected");
    expect(() => decryptCredential(`${ciphertext.slice(0, -1)}A`)).toThrow(
      /Invalid protected credential/,
    );
    const first = credentialVerifier("same-value");
    vi.stubEnv(
      "PANTHER_AUTH_SECRET",
      "different-test-secret-that-is-also-long-enough-for-use",
    );
    expect(credentialVerifier("same-value")).not.toBe(first);
  });

  it("generates independent production-shaped identifiers", () => {
    expect(generateStudentSessionCode()).toMatch(/^signup-[a-f0-9]{32}$/);
    expect(generateStaffAccessCode()).toMatch(/^\d{8}$/);
    expect(generateStaffLinkToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateStaffSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateStaffLinkToken()).not.toBe(generateStaffLinkToken());
  });

  it("fails closed when the server authentication secret is absent", () => {
    vi.stubEnv("PANTHER_AUTH_SECRET", "");
    expect(() => credentialVerifier("value")).toThrow(/PANTHER_AUTH_SECRET/);
  });
});
