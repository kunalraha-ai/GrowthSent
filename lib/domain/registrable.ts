import { getDomain } from "tldts";

/**
 * Normalizes a hostname for comparisons only. URL validation remains the
 * responsibility of the SSRF guard; this helper never makes a host safe to
 * fetch by itself.
 */
export function normalizeComparableHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Returns the ICANN registrable domain when the public suffix list can
 * determine one. IP addresses and unknown suffixes deliberately return null.
 */
export function registrableDomain(hostname: string): string | null {
  const normalized = normalizeComparableHostname(hostname);
  return getDomain(normalized, { allowPrivateDomains: false })?.toLowerCase() || null;
}

/**
 * Treat hostnames under the same registrable domain as the same site for
 * backlink semantics. This excludes www/apex and sibling-subdomain links from
 * external-link observations without guessing public suffix boundaries.
 */
export function hasSameRegistrableDomain(left: string, right: string): boolean {
  const leftDomain = registrableDomain(left);
  const rightDomain = registrableDomain(right);
  return Boolean(leftDomain && rightDomain && leftDomain === rightDomain);
}

/**
 * Crawl scope is intentionally narrower than backlink ownership. A crawl can
 * continue across the common www/apex alias, but it must not recursively grow
 * into sibling subdomains or unrelated public hosts after a redirect.
 */
export function isWithinCrawlOriginScope(originHostname: string, candidateHostname: string): boolean {
  const origin = normalizeComparableHostname(originHostname);
  const candidate = normalizeComparableHostname(candidateHostname);
  if (!origin || !candidate) return false;
  if (origin === candidate) return true;
  if (!hasSameRegistrableDomain(origin, candidate)) return false;

  const withoutWww = (hostname: string) => hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  return withoutWww(origin) === withoutWww(candidate);
}

export function isUrlWithinCrawlOriginScope(originUrl: string, candidateUrl: string): boolean {
  try {
    return isWithinCrawlOriginScope(new URL(originUrl).hostname, new URL(candidateUrl).hostname);
  } catch {
    return false;
  }
}
