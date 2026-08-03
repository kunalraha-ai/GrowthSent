import { validateUrlForScan } from "../security/ssrf.js";

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
  error?: string;
}

const DEFAULT_USER_AGENT = process.env.CRAWLER_USER_AGENT || "GrowthSentBot/1.0 (+https://growthsent.com)";
const DEFAULT_TIMEOUT_MS = parseInt(process.env.CRAWLER_TIMEOUT || "10000", 10);
const DEFAULT_MAX_SIZE = 2 * 1024 * 1024; // 2 MB max

export async function fetchUrl(
  inputUrl: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  const maxRedirects = options.maxRedirects ?? 5;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  let currentUrl = inputUrl;
  const redirectChain: string[] = [currentUrl];
  let redirectCount = 0;
  const startTime = Date.now();

  while (redirectCount <= maxRedirects) {
    const ssrfCheck = await validateUrlForScan(currentUrl);
    if (!ssrfCheck.isValid) {
      return {
        url: inputUrl,
        finalUrl: currentUrl,
        statusCode: 0,
        responseTimeMs: Date.now() - startTime,
        contentType: "",
        body: "",
        pageSizeBytes: 0,
        redirectChain,
        error: `SSRF Guard blocked URL: ${ssrfCheck.reason}`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const responseTimeMs = Date.now() - startTime;
      const statusCode = response.status;
      const contentType = response.headers.get("content-type") || "";

      // Check redirects
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = response.headers.get("location");
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
            error: "Redirect status returned without Location header.",
          };
        }

        const resolvedLocation = new URL(location, currentUrl).toString();
        redirectChain.push(resolvedLocation);
        currentUrl = resolvedLocation;
        redirectCount++;
        continue;
      }

      // Download content with size cap
      const arrayBuffer = await response.arrayBuffer();
      const pageSizeBytes = arrayBuffer.byteLength;

      if (pageSizeBytes > maxSizeBytes) {
        return {
          url: inputUrl,
          finalUrl: currentUrl,
          statusCode,
          responseTimeMs,
          contentType,
          body: "",
          pageSizeBytes,
          redirectChain,
          error: `Response size exceeds limit of ${maxSizeBytes} bytes.`,
        };
      }

      const decoder = new TextDecoder("utf-8");
      const body = decoder.decode(arrayBuffer);

      return {
        url: inputUrl,
        finalUrl: currentUrl,
        statusCode,
        responseTimeMs,
        contentType,
        body,
        pageSizeBytes,
        redirectChain,
      };
    } catch (err: any) {
      clearTimeout(timeout);
      const responseTimeMs = Date.now() - startTime;
      const errMsg = err.name === "AbortError" ? "Request timed out." : err.message || "Network request failed.";
      return {
        url: inputUrl,
        finalUrl: currentUrl,
        statusCode: 0,
        responseTimeMs,
        contentType: "",
        body: "",
        pageSizeBytes: 0,
        redirectChain,
        error: errMsg,
      };
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
    error: `Exceeded maximum redirect limit of ${maxRedirects}.`,
  };
}
