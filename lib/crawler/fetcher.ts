import { request as httpRequest, type ClientRequestArgs, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type ResolvedAddress, validateUrlForScan } from "../security/ssrf.js";

export interface FetchOptions {
  timeoutMs?: number;
  maxSizeBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  responseTimeMs: number;
  contentType: string;
  body: string;
  pageSizeBytes: number;
  redirectChain: string[];
  /** Safe, non-target-specific classification retained for audit diagnostics. */
  failureCategory?: FetchFailureCategory;
  error?: string;
}

export type FetchFailureCategory =
  | "blocked_by_safety_policy"
  | "invalid_redirect"
  | "response_body_unavailable"
  | "response_size_limit"
  | "timeout"
  | "network"
  | "redirect_limit";

export interface BoundedBodyResult {
  body?: Buffer;
  pageSizeBytes: number;
  exceeded: boolean;
}

type AsyncBody = AsyncIterable<unknown> & {
  destroy?: (error?: Error) => unknown;
};

const DEFAULT_USER_AGENT = process.env.CRAWLER_USER_AGENT || "GrowthSentBot/1.0 (+https://growthsent.com)";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.CRAWLER_TIMEOUT || "10000", 10);
const DEFAULT_MAX_SIZE = 2 * 1024 * 1024; // 2 MB max
const FIRST_PARTY_AUDIT_HEADER = "X-GrowthSent-Audit-Token";

export interface FirstPartyAuditConfig {
  hosts?: string;
  token?: string;
}

function normalizedHostname(value: string): string | undefined {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname)
    ? hostname
    : undefined;
}

/**
 * Returns the private first-party audit header only for an exact host listed
 * in server-side configuration. The decision is made per HTTP request, after
 * redirect and SSRF validation, so a token can never follow a redirect to an
 * unrelated site.
 */
export function firstPartyAuditHeaders(
  hostname: string,
  config: FirstPartyAuditConfig = {}
): Record<string, string> {
  const token = config.token ?? process.env.CRAWLER_FIRST_PARTY_AUDIT_TOKEN;
  const configuredHosts = config.hosts ?? process.env.CRAWLER_FIRST_PARTY_AUDIT_HOSTS ?? "";
  const normalizedRequestedHost = normalizedHostname(hostname);
  if (!token || !normalizedRequestedHost) return {};

  const permittedHosts = new Set(
    configuredHosts
      .split(",")
      .map(normalizedHostname)
      .filter((value): value is string => Boolean(value))
  );
  if (!permittedHosts.has(normalizedRequestedHost)) return {};

  return { [FIRST_PARTY_AUDIT_HEADER]: token };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array || typeof chunk === "string") return Buffer.from(chunk);
  throw new Error("Response stream yielded an unsupported chunk.");
}

/**
 * Read a stream without retaining more than maxSizeBytes. Exported for safe
 * regression testing; fetchUrl uses it for every crawler response.
 */
export async function readBodyWithLimit(source: AsyncBody, maxSizeBytes: number): Promise<BoundedBodyResult> {
  const chunks: Buffer[] = [];
  let pageSizeBytes = 0;

  for await (const chunk of source) {
    const buffer = toBuffer(chunk);
    pageSizeBytes += buffer.byteLength;

    if (pageSizeBytes > maxSizeBytes) {
      source.destroy?.(new Error("Response size limit exceeded."));
      return { pageSizeBytes, exceeded: true };
    }

    chunks.push(buffer);
  }

  return {
    body: Buffer.concat(chunks, pageSizeBytes),
    pageSizeBytes,
    exceeded: false,
  };
}

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function declaredContentLength(headers: IncomingMessage["headers"]): number | undefined {
  const header = headerValue(headers, "content-length");
  if (!header || !/^\d+$/.test(header)) return undefined;

  const parsed = Number.parseInt(header, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decodedStream(response: IncomingMessage): { source?: AsyncBody; error?: string } {
  const rawEncoding = headerValue(response.headers, "content-encoding")?.toLowerCase();
  const encodings = rawEncoding
    ? rawEncoding.split(",").map((encoding) => encoding.trim()).filter((encoding) => encoding && encoding !== "identity")
    : [];

  let source: AsyncBody = response;
  for (const encoding of encodings.reverse()) {
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        source = (source as IncomingMessage).pipe(createGunzip());
        break;
      case "deflate":
        source = (source as IncomingMessage).pipe(createInflate());
        break;
      case "br":
        source = (source as IncomingMessage).pipe(createBrotliDecompress());
        break;
      default:
        return { error: "Response uses an unsupported content encoding." };
    }
  }

  return { source };
}

async function readHttpResponse(response: IncomingMessage, maxSizeBytes: number): Promise<BoundedBodyResult | { error: string }> {
  const declaredSize = declaredContentLength(response.headers);
  if (declaredSize !== undefined && declaredSize > maxSizeBytes) {
    response.resume();
    return {
      pageSizeBytes: maxSizeBytes,
      exceeded: true,
    };
  }

  const decoded = decodedStream(response);
  if (!decoded.source) {
    response.resume();
    return { error: decoded.error || "Response body could not be decoded." };
  }

  try {
    const result = await readBodyWithLimit(decoded.source, maxSizeBytes);
    if (result.exceeded) {
      response.destroy();
    }
    return result;
  } catch {
    response.destroy();
    return { error: "Response body could not be read safely." };
  }
}

export function createPinnedLookup(resolvedAddress: ResolvedAddress): LookupFunction {
  return (_requestedHostname, options, callback) => {
    // Node 20+ may request every address for automatic family selection.
    // This request is intentionally pinned to exactly one address that passed
    // SSRF validation, so return that address in the callback shape Node
    // requested instead of letting it see an undefined candidate.
    if (options.all) {
      callback(null, [{ address: resolvedAddress.address, family: resolvedAddress.family }]);
      return;
    }
    callback(null, resolvedAddress.address, resolvedAddress.family);
  };
}

function requestPinnedUrl(
  url: string,
  hostname: string,
  resolvedAddress: ResolvedAddress,
  userAgent: string,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const parsed = new URL(url);
  const lookup = createPinnedLookup(resolvedAddress);

  const requestOptions: ClientRequestArgs = {
    protocol: parsed.protocol,
    hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: "GET",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...firstPartyAuditHeaders(hostname),
    },
    lookup,
    // Do not reuse a socket that was opened for another resolution. This keeps
    // the connection tied to the DNS answer validated immediately above.
    agent: false,
    signal,
  };

  return new Promise((resolve, reject) => {
    const onResponse = (response: IncomingMessage) => resolve(response);
    const request = parsed.protocol === "https:"
      ? httpsRequest(requestOptions, onResponse)
      : httpRequest(requestOptions, onResponse);

    request.once("error", reject);
    request.end();
  });
}

export async function fetchUrl(
  inputUrl: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxSizeBytes = normalizePositiveInteger(options.maxSizeBytes, DEFAULT_MAX_SIZE);
  const maxRedirects = normalizePositiveInteger(options.maxRedirects, 5);
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  let currentUrl = inputUrl;
  const redirectChain: string[] = [currentUrl];
  let redirectCount = 0;
  const startTime = Date.now();

  while (redirectCount <= maxRedirects) {
    const ssrfCheck = await validateUrlForScan(currentUrl);
    if (!ssrfCheck.isValid || !ssrfCheck.normalizedUrl || !ssrfCheck.hostname || !ssrfCheck.resolvedAddress) {
      return {
        url: inputUrl,
        finalUrl: currentUrl,
        statusCode: 0,
        responseTimeMs: Date.now() - startTime,
        contentType: "",
        body: "",
        pageSizeBytes: 0,
        redirectChain,
        failureCategory: "blocked_by_safety_policy",
        error: "URL was blocked by the crawler safety policy.",
      };
    }

    currentUrl = ssrfCheck.normalizedUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Pin the request to the validated address so the HTTP client cannot
      // resolve the hostname again between SSRF validation and connection.
      const response = await requestPinnedUrl(
        currentUrl,
        ssrfCheck.hostname,
        ssrfCheck.resolvedAddress,
        userAgent,
        controller.signal
      );
      const responseTimeMs = Date.now() - startTime;
      const statusCode = response.statusCode || 0;
      const contentType = headerValue(response.headers, "content-type") || "";

      // Validate each redirect target before opening a new connection.
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = headerValue(response.headers, "location");
        response.resume();

        if (!location) {
          return {
            url: inputUrl,
            finalUrl: currentUrl,
            statusCode,
            responseTimeMs,
            contentType,
            body: "",
            pageSizeBytes: 0,
            redirectChain,
            failureCategory: "invalid_redirect",
            error: "Redirect status returned without a Location header.",
          };
        }

        try {
          const redirectTarget = new URL(location, currentUrl);
          if (redirectTarget.username || redirectTarget.password) {
            return {
              url: inputUrl,
              finalUrl: currentUrl,
              statusCode,
              responseTimeMs,
              contentType,
              body: "",
              pageSizeBytes: 0,
              redirectChain,
              failureCategory: "invalid_redirect",
              error: "Redirect URL contains credentials.",
            };
          }
          currentUrl = redirectTarget.toString();
        } catch {
          return {
            url: inputUrl,
            finalUrl: currentUrl,
            statusCode,
            responseTimeMs,
            contentType,
            body: "",
            pageSizeBytes: 0,
            redirectChain,
            failureCategory: "invalid_redirect",
            error: "Redirect returned an invalid Location header.",
          };
        }

        redirectChain.push(currentUrl);
        redirectCount++;
        continue;
      }

      const bodyResult = await readHttpResponse(response, maxSizeBytes);
      if ("error" in bodyResult) {
        return {
          url: inputUrl,
          finalUrl: currentUrl,
          statusCode,
          responseTimeMs,
          contentType,
          body: "",
          pageSizeBytes: 0,
          redirectChain,
          failureCategory: "response_body_unavailable",
          error: bodyResult.error,
        };
      }

      if (bodyResult.exceeded || !bodyResult.body) {
        return {
          url: inputUrl,
          finalUrl: currentUrl,
          statusCode,
          responseTimeMs,
          contentType,
          body: "",
          pageSizeBytes: bodyResult.pageSizeBytes,
          redirectChain,
          failureCategory: "response_size_limit",
          error: `Response size exceeds limit of ${maxSizeBytes} bytes.`,
        };
      }

      return {
        url: inputUrl,
        finalUrl: currentUrl,
        statusCode,
        responseTimeMs,
        contentType,
        body: new TextDecoder("utf-8").decode(bodyResult.body),
        pageSizeBytes: bodyResult.pageSizeBytes,
        redirectChain,
      };
    } catch (err: unknown) {
      const responseTimeMs = Date.now() - startTime;
      const wasAborted = err instanceof Error && (err.name === "AbortError" || controller.signal.aborted);
      return {
        url: inputUrl,
        finalUrl: currentUrl,
        statusCode: 0,
        responseTimeMs,
        contentType: "",
        body: "",
        pageSizeBytes: 0,
        redirectChain,
        failureCategory: wasAborted ? "timeout" : "network",
        error: wasAborted ? "Request timed out." : "Network request failed.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    url: inputUrl,
    finalUrl: currentUrl,
    statusCode: 0,
    responseTimeMs: Date.now() - startTime,
    contentType: "",
    body: "",
    pageSizeBytes: 0,
    redirectChain,
    failureCategory: "redirect_limit",
    error: `Exceeded maximum redirect limit of ${maxRedirects}.`,
  };
}
