import { getDomain } from "tldts";

const BUCKET_COUNT = 1024;

/**
 * Normalize an input string to the registrable domain used by the index.
 * - Strips schemes, paths, ports, and query strings.
 * - Uses the public suffix list with private suffixes enabled to match the
 *   Python `tldextract` configuration used at materialization time.
 * - Lower-cases and trims the result.
 */
export function normalizeDomain(input: string): string | null {
  let cleaned = input.trim().toLowerCase();
  if (!cleaned) return null;

  // If the caller already passed a bare domain, avoid throwing on schemes.
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = "https://" + cleaned;
  }

  let hostname: string;
  try {
    hostname = new URL(cleaned).hostname;
  } catch {
    hostname = input.trim().toLowerCase();
  }

  if (!hostname || hostname === "localhost") return null;

  const registrable = getDomain(hostname, { allowPrivateDomains: true });
  return registrable || hostname;
}

/**
 * Compute the target-domain bucket for a normalized domain.
 *
 * Mirrors the DuckDB expression used during materialization:
 *   (CAST('0x' || substr(sha256(target_domain), 1, 3) AS BIGINT) >> 2)::INTEGER
 * which partitions 0..1023.
 */
export async function domainBucket(domain: string): Promise<number> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(domain));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const prefix3 = hex.slice(0, 3);
  return (parseInt(prefix3, 16) >> 2) % BUCKET_COUNT;
}

export { BUCKET_COUNT };
