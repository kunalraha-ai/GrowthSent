import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const REQUESTER_KEY_PREFIX = "ccr_";

/**
 * Produces a non-reversible, stable admission identity for Common Crawl work.
 * It is deliberately separate from public access capabilities and is never
 * returned from an API response. Authenticated callers are keyed by their
 * server-side user identifier; anonymous callers are keyed by a trusted
 * request IP supplied by the existing API ingress boundary.
 */
export function createCommonCrawlRequesterKey(input: { userId?: string; requestIp?: string }): string {
  const subject = input.userId ? userSubject(input.userId) : ipSubject(input.requestIp);
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    // Common Crawl admission must not fall back to an unsalted IP/user hash.
    // Live crawling remains unaffected because this function is only invoked
    // when the server selected the archive provider.
    throw new Error("Common Crawl admission requires SESSION_SECRET.");
  }
  return `${REQUESTER_KEY_PREFIX}${createHmac("sha256", secret).update(subject, "utf8").digest("hex")}`;
}

/** Validates only opaque HMAC keys read back from durable job documents. */
export function isCommonCrawlRequesterKey(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${REQUESTER_KEY_PREFIX}[a-f0-9]{64}$`).test(value);
}

function userSubject(userId: string): string {
  if (!/^[a-f0-9]{24}$/i.test(userId)) throw new Error("Common Crawl requester identity is invalid.");
  return `user:${userId.toLowerCase()}`;
}

function ipSubject(requestIp: string | undefined): string {
  const normalized = requestIp?.trim().toLowerCase();
  if (!normalized || isIP(normalized) === 0) throw new Error("Common Crawl requester IP is invalid.");
  return `ip:${normalized}`;
}
