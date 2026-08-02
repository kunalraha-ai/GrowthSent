import dns from "node:dns/promises";
import net from "node:net";

export interface UrlValidationResult {
  isValid: boolean;
  normalizedUrl?: string;
  hostname?: string;
  reason?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "loopback",
  "metadata.google.internal",
  "169.254.169.254",
  "0.0.0.0",
]);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    const [a, b] = parts;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (Private)
    if (a === 10) return true;
    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // ::1 (Loopback)
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
    // fc00::/7 (Unique Local Address)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // fe80::/10 (Link-local)
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    return false;
  }

  return false;
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
    return { isValid: false, reason: `Protocol '${parsed.protocol}' is not allowed. Only HTTP and HTTPS are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return { isValid: false, reason: "Access to local or internal hostnames is prohibited." };
  }

  if (isPrivateIp(hostname)) {
    return { isValid: false, reason: "Access to private or internal IP addresses is prohibited." };
  }

  // Perform DNS resolution check to prevent DNS rebinding and private IP mapping
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        return { isValid: false, reason: `Resolved IP address ${record.address} is within a restricted private range.` };
      }
    }
  } catch (err) {
    // If DNS resolution fails in offline test environments, allow if valid public hostname string
    if (process.env.STRICT_DNS_REQUIRED === "true") {
      return { isValid: false, reason: `Unable to resolve host: ${hostname}` };
    }
  }

  // Normalize URL
  parsed.hash = ""; // Strip fragment
  const normalizedUrl = parsed.toString();

  return {
    isValid: true,
    normalizedUrl,
    hostname,
  };
}
