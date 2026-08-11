import dns from "node:dns/promises";
import net from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface UrlValidationResult {
  isValid: boolean;
  normalizedUrl?: string;
  hostname?: string;
  /**
   * A DNS answer that was checked by the SSRF guard. Callers that open a
   * connection must pin their lookup to this address instead of resolving the
   * hostname a second time.
   */
  resolvedAddress?: ResolvedAddress;
  reason?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "loopback",
  "metadata.google.internal",
  "metadata.aws.internal",
]);

function normalizeHostname(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b, c] = parts;

  // Unspecified, loopback, RFC1918, shared address space, link-local, and
  // IETF special-purpose ranges. These ranges must never be fetched by the
  // crawler, even if they are supplied through DNS or an IPv6 transition form.
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 31 && c === 196) return true;
  if (a === 192 && b === 52 && c === 193) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 175 && c === 48) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;

  return false;
}

function ipv6ToBytes(ip: string): number[] | undefined {
  let normalized = ip.toLowerCase();

  // Convert an embedded dotted-quad (for example ::ffff:127.0.0.1) into two
  // hexadecimal groups before expanding the IPv6 address.
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4Part = normalized.slice(lastColon + 1);
    if (!net.isIPv4(ipv4Part)) return undefined;

    const [a, b, c, d] = ipv4Part.split(".").map((part) => Number.parseInt(part, 10));
    normalized = `${normalized.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const separatorIndex = normalized.indexOf("::");
  const hasCompression = separatorIndex !== -1;
  const left = hasCompression ? normalized.slice(0, separatorIndex) : normalized;
  const right = hasCompression ? normalized.slice(separatorIndex + 2) : "";
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missingGroups = 8 - leftGroups.length - rightGroups.length;

  if ((hasCompression && missingGroups < 1) || (!hasCompression && missingGroups !== 0)) {
    return undefined;
  }

  const groups = hasCompression
    ? [...leftGroups, ...Array.from({ length: missingGroups }, () => "0"), ...rightGroups]
    : leftGroups;

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return undefined;
  }

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function hasPrefix(bytes: number[], prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isBlockedIpv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true;

  const isUnspecified = bytes.every((value) => value === 0);
  const isLoopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  if (isUnspecified || isLoopback) return true;

  // Unique-local, link-local/site-local, and multicast ranges.
  if ((bytes[0] & 0xfe) === 0xfc || bytes[0] === 0xfe || bytes[0] === 0xff) return true;

  // Documentation, Teredo, and 6to4 ranges are not valid crawl targets. They
  // also avoid accidentally reaching private IPv4 addresses through a tunnel.
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) return true;
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00])) return true;
  if (hasPrefix(bytes, [0x20, 0x02])) return true;
  if (hasPrefix(bytes, [0x01, 0x00, 0x00, 0x00])) return true; // 100::/64 discard-only

  const embeddedIpv4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const isIpv4Mapped = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isIpv4Compatible = bytes.slice(0, 12).every((value) => value === 0);
  const isWellKnownNat64 = hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b]) && bytes.slice(4, 12).every((value) => value === 0);

  if ((isIpv4Mapped || isIpv4Compatible || isWellKnownNat64) && isBlockedIpv4(embeddedIpv4)) {
    return true;
  }

  return false;
}

export function isBlockedIp(ip: string): boolean {
  const normalized = normalizeHostname(ip);

  if (net.isIPv4(normalized)) return isBlockedIpv4(normalized);
  if (net.isIPv6(normalized)) return isBlockedIpv6(normalized);

  // A DNS result that is not a literal IP is not safe to use for a connection.
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  return (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localdomain") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home")
  );
}

export async function validateUrlForScan(inputUrl: string): Promise<UrlValidationResult> {
  if (!inputUrl || typeof inputUrl !== "string") {
    return { isValid: false, reason: "URL must be a non-empty string." };
  }

  let formatted = inputUrl.trim();
  if (!formatted.includes("://")) {
    formatted = "https://" + formatted;
  }

  let parsed: URL;
  try {
    parsed = new URL(formatted);
  } catch {
    return { isValid: false, reason: "Invalid URL format." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { isValid: false, reason: "Only HTTP and HTTPS URLs are allowed." };
  }

  if (parsed.username || parsed.password) {
    return { isValid: false, reason: "URLs containing credentials are not allowed." };
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    return { isValid: false, reason: "URL must include a hostname." };
  }

  if (isBlockedHostname(hostname)) {
    return { isValid: false, reason: "Access to local or internal hostnames is prohibited." };
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return { isValid: false, reason: "Access to private or reserved IP addresses is prohibited." };
    }

    const family = net.isIP(hostname) as 4 | 6;
    parsed.hash = "";
    return {
      isValid: true,
      normalizedUrl: parsed.toString(),
      hostname,
      resolvedAddress: { address: hostname, family },
    };
  }

  // Resolve every time a URL is fetched and reject the full hostname if any
  // answer is restricted. A transient DNS failure is deliberately fail-closed:
  // a crawler must never turn an unavailable validation step into an internal
  // network request.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { isValid: false, reason: "Unable to resolve host safely." };
  }

  if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
    return { isValid: false, reason: "Host resolves to a restricted address." };
  }

  const selected = records[0];
  const family = selected.family === 6 ? 6 : selected.family === 4 ? 4 : undefined;
  if (!family) {
    return { isValid: false, reason: "Host resolved to an unsupported address family." };
  }

  parsed.hash = "";
  return {
    isValid: true,
    normalizedUrl: parsed.toString(),
    hostname,
    resolvedAddress: { address: selected.address, family },
  };
}
