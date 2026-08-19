import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
} from "node:crypto";
import { z } from "zod";

const authSecretSchema = z.string().min(32).max(1_024);
const ciphertextSchema = z
  .string()
  .max(2_048)
  .regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

function authSecret(): string {
  const parsed = authSecretSchema.safeParse(process.env.PANTHER_AUTH_SECRET);
  if (!parsed.success) {
    throw new Error("Missing or invalid PANTHER_AUTH_SECRET");
  }
  return parsed.data;
}

function deriveKey(purpose: "encryption" | "verifier"): Buffer {
  return createHmac("sha256", authSecret())
    .update(`panther-carts:${purpose}:v1`, "utf8")
    .digest();
}

export function credentialVerifier(value: string): string {
  return createHmac("sha256", deriveKey("verifier"))
    .update(value, "utf8")
    .digest("hex");
}

export function legacyCredentialVerifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function encryptCredential(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("encryption"), iv);
  cipher.setAAD(Buffer.from("panther-carts:staff-credential:v1", "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptCredential(value: string): string {
  const parsed = ciphertextSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid protected credential");
  const [, encodedIv, encodedTag, encodedCiphertext] = parsed.data.split(".");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey("encryption"),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAAD(Buffer.from("panther-carts:staff-credential:v1", "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Invalid protected credential");
  }
}

export function generateStudentSessionCode(): string {
  return `signup-${randomBytes(16).toString("hex")}`;
}

export function generateStaffLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateStaffAccessCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

export function generateStaffSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
