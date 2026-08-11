import { isIP } from "node:net";

export interface ClientIpRequestSource {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
}

/**
 * Resolves the one IP identity used by request rate limits and archive
 * admission. A browser-provided X-Forwarded-For is never trusted directly.
 * On Vercel, `x-vercel-forwarded-for` is injected by the platform; elsewhere
 * we use the immediate peer address, which is conservative behind an
 * unconfigured reverse proxy instead of allowing client spoofing.
 */
export function resolveTrustedClientIp(
  request: ClientIpRequestSource,
  isVercelDeployment = process.env.VERCEL === "1"
): string {
  const socketIp = normalizeIp(request.socket?.remoteAddress);
  if (isVercelDeployment) {
    const vercelIp = normalizeIp(singleHeader(request.headers, "x-vercel-forwarded-for"));
    if (vercelIp) return vercelIp;
  }
  return socketIp || "127.0.0.1";
}

function singleHeader(headers: ClientIpRequestSource["headers"], wantedName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wantedName);
  if (!entry) return undefined;
  const value = entry[1];
  // A single platform-provided address is expected. Lists are not accepted:
  // choosing a caller-controlled element would reintroduce spoofing.
  if (Array.isArray(value) || typeof value !== "string" || value.includes(",")) return undefined;
  return value;
}

function normalizeIp(value: string | null | undefined): string | undefined {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return undefined;
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(candidate)?.[1];
  const normalized = mappedV4 || candidate;
  return isIP(normalized) === 0 ? undefined : normalized;
}
