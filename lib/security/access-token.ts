import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generates a high-entropy bearer capability. Callers must return it only once
 * to the browser and persist `hashOpaqueAccessToken(token)`, never this value.
 */
export function createOpaqueAccessToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashOpaqueAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compares SHA-256 hashes without leaking a prefix match through timing.
 * Invalid/missing values are deliberately denied.
 */
export function verifyOpaqueAccessToken(token: string | undefined, storedHash: string | undefined): boolean {
  if (!token || !storedHash || !/^[a-f0-9]{64}$/i.test(storedHash)) return false;

  const candidate = Buffer.from(hashOpaqueAccessToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}
