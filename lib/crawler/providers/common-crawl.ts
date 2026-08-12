import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequestArgs, IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { parsePageHtml } from "../parser.js";
import type { CrawlEngineOptions, CrawledPageResult, CrawlExecutionResult } from "../crawler.js";
import type {
  CommonCrawlMetrics,
  CommonCrawlPageProvenance,
  CrawlProviderCapabilities,
} from "../types.js";
import { isBlockedIp, validateUrlForScan, type UrlValidationResult } from "../../security/ssrf.js";

const COLLECTION_INFO_URL = new URL("https://index.commoncrawl.org/collinfo.json");
const INDEX_HOST = "index.commoncrawl.org";
const DATA_HOST = "data.commoncrawl.org";
const MAX_TARGET_URL_LENGTH = 2_048;
const MAX_COLLECTIONS = 512;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_HEADER_FIELDS = 100;

export const COMMON_CRAWL_DEFAULT_LIMITS = {
  maxPages: 10,
  maxIndexResponseBytes: 512 * 1024,
  maxIndexLineBytes: 16 * 1024,
  maxCompressedBytesPerRange: 1 * 1024 * 1024,
  maxTotalCompressedBytes: 8 * 1024 * 1024,
  maxDecompressedBytesPerRecord: 2_250 * 1024,
  maxTotalDecompressedBytes: 12 * 1024 * 1024,
  maxHtmlBytesPerPage: 2 * 1024 * 1024,
  maxConcurrency: 2,
  collectionLookupTimeoutMs: 3_000,
  indexLookupTimeoutMs: 8_000,
  rangeTimeoutMs: 10_000,
  totalTimeoutMs: 90_000,
  maxRetries: 2,
} as const;

export interface CommonCrawlLimits {
  maxPages: number;
  maxIndexResponseBytes: number;
  maxIndexLineBytes: number;
  maxCompressedBytesPerRange: number;
  maxTotalCompressedBytes: number;
  maxDecompressedBytesPerRecord: number;
  maxTotalDecompressedBytes: number;
  maxHtmlBytesPerPage: number;
  maxConcurrency: number;
  collectionLookupTimeoutMs: number;
  indexLookupTimeoutMs: number;
  rangeTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetries: number;
}

export interface CommonCrawlHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface CommonCrawlHttpTransport {
  get(
    url: URL,
    options: {
      headers?: Record<string, string>;
      timeoutMs: number;
      maxBytes: number;
      /** Reserve response bytes before buffering them, when the caller needs a shared budget. */
      onBytesReceived?: (bytes: number) => void;
    }
  ): Promise<CommonCrawlHttpResponse>;
}

export interface NormalizedCommonCrawlTarget {
  normalizedUrl: string;
  hostname: string;
  /** A non-root path/query must only retrieve the requested archived URL. */
  isExactUrl: boolean;
}

export interface CommonCrawlCollection {
  id: string;
  cdxApi: string;
}

export interface CommonCrawlIndexRecord {
  url: string;
  normalizedUrl: string;
  timestamp: string;
  captureTimestamp: Date;
  filename: string;
  offset: number;
  length: number;
}

export interface ParsedWarcResponse {
  targetUrl: string;
  captureTimestamp: Date;
  statusCode: number;
  contentType: string;
  html: Buffer;
}

export interface CommonCrawlProviderOptions {
  limits?: Partial<CommonCrawlLimits>;
  transport?: CommonCrawlHttpTransport;
  targetValidator?: (inputUrl: string) => Promise<UrlValidationResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  metricsSink?: (metrics: CommonCrawlMetrics) => void;
}

export class CommonCrawlProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly metrics: CommonCrawlMetrics;

  constructor(code: string, retryable: boolean, metrics: CommonCrawlMetrics) {
    super("Common Crawl provider could not safely complete the crawl.");
    this.name = "CommonCrawlProviderError";
    this.code = code;
    this.retryable = retryable;
    this.metrics = metrics;
  }
}

class ProviderFault extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly observedBytes?: number) {
    super(code);
  }
}

function fault(code: string, retryable = false, observedBytes?: number): ProviderFault {
  return new ProviderFault(code, retryable, observedBytes);
}

function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseDeclaredContentLength(headers: IncomingHttpHeaders): number | undefined {
  const value = getHeader(headers, "content-length");
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw fault("INVALID_CONTENT_LENGTH");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw fault("INVALID_CONTENT_LENGTH");
  return parsed;
}

function boundedConfiguredInteger(value: number | undefined, fallback: number, hardMaximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error("Common Crawl limit configuration is invalid.");
  }
  return Math.min(value, hardMaximum);
}

function resolveLimits(overrides: Partial<CommonCrawlLimits> | undefined): CommonCrawlLimits {
  const defaults = COMMON_CRAWL_DEFAULT_LIMITS;
  return {
    maxPages: boundedConfiguredInteger(overrides?.maxPages, defaults.maxPages, defaults.maxPages),
    maxIndexResponseBytes: boundedConfiguredInteger(
      overrides?.maxIndexResponseBytes,
      defaults.maxIndexResponseBytes,
      defaults.maxIndexResponseBytes
    ),
    maxIndexLineBytes: boundedConfiguredInteger(
      overrides?.maxIndexLineBytes,
      defaults.maxIndexLineBytes,
      defaults.maxIndexLineBytes
    ),
    maxCompressedBytesPerRange: boundedConfiguredInteger(
      overrides?.maxCompressedBytesPerRange,
      defaults.maxCompressedBytesPerRange,
      defaults.maxCompressedBytesPerRange
    ),
    maxTotalCompressedBytes: boundedConfiguredInteger(
      overrides?.maxTotalCompressedBytes,
      defaults.maxTotalCompressedBytes,
      defaults.maxTotalCompressedBytes
    ),
    maxDecompressedBytesPerRecord: boundedConfiguredInteger(
      overrides?.maxDecompressedBytesPerRecord,
      defaults.maxDecompressedBytesPerRecord,
      defaults.maxDecompressedBytesPerRecord
    ),
    maxTotalDecompressedBytes: boundedConfiguredInteger(
      overrides?.maxTotalDecompressedBytes,
      defaults.maxTotalDecompressedBytes,
      defaults.maxTotalDecompressedBytes
    ),
    maxHtmlBytesPerPage: boundedConfiguredInteger(
      overrides?.maxHtmlBytesPerPage,
      defaults.maxHtmlBytesPerPage,
      defaults.maxHtmlBytesPerPage
    ),
    maxConcurrency: boundedConfiguredInteger(overrides?.maxConcurrency, defaults.maxConcurrency, defaults.maxConcurrency),
    collectionLookupTimeoutMs: boundedConfiguredInteger(
      overrides?.collectionLookupTimeoutMs,
      defaults.collectionLookupTimeoutMs,
      defaults.collectionLookupTimeoutMs
    ),
    indexLookupTimeoutMs: boundedConfiguredInteger(
      overrides?.indexLookupTimeoutMs,
      defaults.indexLookupTimeoutMs,
      defaults.indexLookupTimeoutMs
    ),
    rangeTimeoutMs: boundedConfiguredInteger(overrides?.rangeTimeoutMs, defaults.rangeTimeoutMs, defaults.rangeTimeoutMs),
    totalTimeoutMs: boundedConfiguredInteger(overrides?.totalTimeoutMs, defaults.totalTimeoutMs, defaults.totalTimeoutMs),
    maxRetries: boundedConfiguredInteger(overrides?.maxRetries, defaults.maxRetries, defaults.maxRetries, 0),
  };
}

function canonicalTimestamp(value: string): Date {
  if (!/^\d{14}$/.test(value)) throw fault("INVALID_CDX_TIMESTAMP");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    throw fault("INVALID_CDX_TIMESTAMP");
  }
  return parsed;
}

function canonicalSafeInteger(value: unknown, allowZero: boolean, code: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw fault(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed === 0)) throw fault(code);
  return parsed;
}

function normalizeArchiveUrl(input: string): string {
  if (
    input.length === 0 ||
    input.length > MAX_TARGET_URL_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(input) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(input)
  ) {
    throw fault("UNSAFE_ARCHIVE_URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw fault("UNSAFE_ARCHIVE_URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    parsed.port
  ) {
    throw fault("UNSAFE_ARCHIVE_URL");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  return parsed.toString();
}

/** Normalizes the user target before it is ever interpolated into a CDX query. */
export async function normalizeAndValidateCommonCrawlTarget(
  inputUrl: string,
  validator: (input: string) => Promise<UrlValidationResult> = validateUrlForScan
): Promise<NormalizedCommonCrawlTarget> {
  if (typeof inputUrl !== "string" || inputUrl.length === 0 || inputUrl.length > MAX_TARGET_URL_LENGTH || /[\u0000-\u001F\u007F]/.test(inputUrl)) {
    throw fault("INVALID_TARGET_URL");
  }

  const validated = await validator(inputUrl);
  if (!validated.isValid || !validated.normalizedUrl || !validated.hostname) throw fault("UNSAFE_TARGET_URL");
  const normalizedUrl = normalizeArchiveUrl(validated.normalizedUrl);
  const parsed = new URL(normalizedUrl);
  if (parsed.hostname.toLowerCase() !== validated.hostname.toLowerCase()) throw fault("UNSAFE_TARGET_URL");

  return {
    normalizedUrl,
    hostname: parsed.hostname.toLowerCase(),
    isExactUrl: parsed.pathname !== "/" || Boolean(parsed.search),
  };
}

function assertFixedCommonCrawlUrl(url: URL, expectedHost: string): void {
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== expectedHost ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw fault("UNSAFE_COMMON_CRAWL_ENDPOINT");
  }
}

function parseCollectionId(id: string): number | undefined {
  const match = /^CC-MAIN-(\d{4})-(\d{2})$/.exec(id);
  if (!match) return undefined;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 2013 || week < 1 || week > 53) return undefined;
  return year * 100 + week;
}

/** Parses a bounded collection listing and reconstructs the trusted CDX endpoint. */
export function parseLatestCommonCrawlCollection(payload: Buffer | string): CommonCrawlCollection {
  let value: unknown;
  try {
    value = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
  } catch {
    throw fault("MALFORMED_COLLECTION_LIST");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COLLECTIONS) throw fault("MALFORMED_COLLECTION_LIST");

  const candidates: Array<{ id: string; sortValue: number; availableAt: number }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    const id = data.id;
    const cdxApi = data["cdx-api"];
    const to = data.to;
    if (typeof id !== "string" || typeof cdxApi !== "string" || typeof to !== "string") continue;
    const sortValue = parseCollectionId(id);
    const availableAt = Date.parse(to);
    if (sortValue === undefined || !Number.isFinite(availableAt)) continue;
    try {
      const publishedEndpoint = new URL(cdxApi);
      if (
        publishedEndpoint.protocol !== "https:" ||
        publishedEndpoint.hostname.toLowerCase() !== INDEX_HOST ||
        publishedEndpoint.username ||
        publishedEndpoint.password ||
        publishedEndpoint.port ||
        publishedEndpoint.hash
      ) {
        continue;
      }
    } catch {
      continue;
    }
    candidates.push({ id, sortValue, availableAt });
  }
  if (candidates.length === 0) throw fault("NO_VALID_COMMON_CRAWL_COLLECTION");
  candidates.sort((a, b) => b.availableAt - a.availableAt || b.sortValue - a.sortValue);
  const latest = candidates[0];
  return {
    id: latest.id,
    cdxApi: `https://${INDEX_HOST}/${latest.id}-index`,
  };
}

/** Common Crawl uses a strict JSON 404 for a valid lookup with no captures. */
function isNoCapturesIndexResponse(response: CommonCrawlHttpResponse, lookupValue: string): boolean {
  if (response.statusCode !== 404) return false;
  try {
    const value = JSON.parse(response.body.toString("utf8")) as unknown;
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).message === `No Captures found for: ${lookupValue}`
    );
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateWarcFilename(filename: unknown, collection: string): string {
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 512) throw fault("INVALID_WARC_FILENAME");
  const pattern = new RegExp(
    `^crawl-data/${escapeRegExp(collection)}/segments/[A-Za-z0-9._-]+/warc/[A-Za-z0-9._-]+\\.warc\\.gz$`
  );
  if (!pattern.test(filename)) throw fault("INVALID_WARC_FILENAME");
  return filename;
}

function isHtmlMime(value: unknown): boolean {
  return typeof value === "string" && value.split(";", 1)[0].trim().toLowerCase() === "text/html";
}

/** Strictly parses all nonblank CDX JSON lines; a malformed line fails the whole lookup. */
export function parseCommonCrawlIndexRecords(
  payload: Buffer | string,
  target: NormalizedCommonCrawlTarget,
  collection: string,
  limits: Pick<CommonCrawlLimits, "maxPages" | "maxIndexLineBytes" | "maxCompressedBytesPerRange">
): CommonCrawlIndexRecord[] {
  const text = typeof payload === "string" ? payload : payload.toString("utf8");
  const records: CommonCrawlIndexRecord[] = [];
  const ranges = new Set<string>();
  const urls = new Set<string>();
  let examinedRecords = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > limits.maxIndexLineBytes) throw fault("INDEX_LINE_LIMIT_EXCEEDED");
    if (examinedRecords >= limits.maxPages) throw fault("INDEX_RECORD_LIMIT_EXCEEDED");
    examinedRecords++;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw fault("MALFORMED_CDX_RECORD");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fault("MALFORMED_CDX_RECORD");
    const record = value as Record<string, unknown>;
    if (record.status !== "200" || !isHtmlMime(record.mime) || typeof record.url !== "string" || typeof record.timestamp !== "string") {
      throw fault("MALFORMED_CDX_RECORD");
    }

    const normalizedUrl = normalizeArchiveUrl(record.url);
    const parsedUrl = new URL(normalizedUrl);
    const captureTimestamp = canonicalTimestamp(record.timestamp);
    const filename = validateWarcFilename(record.filename, collection);
    const offset = canonicalSafeInteger(record.offset, true, "INVALID_CDX_OFFSET");
    const length = canonicalSafeInteger(record.length, false, "INVALID_CDX_LENGTH");
    if (length > limits.maxCompressedBytesPerRange || offset > Number.MAX_SAFE_INTEGER - (length - 1)) {
      throw fault("INVALID_CDX_RANGE");
    }

    // Index implementations can return canonical aliases despite host scope.
    // Treat those records as untrusted-but-valid noise: do not fetch or retain
    // them, while still validating every field in the bounded response.
    if (parsedUrl.hostname.toLowerCase() !== target.hostname || (target.isExactUrl && normalizedUrl !== target.normalizedUrl)) {
      continue;
    }
    if (urls.has(normalizedUrl)) continue;

    const rangeKey = `${filename}:${offset}:${length}`;
    if (ranges.has(rangeKey)) continue;
    ranges.add(rangeKey);
    urls.add(normalizedUrl);
    records.push({
      url: record.url,
      normalizedUrl,
      timestamp: record.timestamp,
      captureTimestamp,
      filename,
      offset,
      length,
    });
  }

  return records;
}

function parseHeaderBlock(buffer: Buffer, expectedFirstLine: (line: string) => boolean): { headers: Map<string, string>; bodyOffset: number } {
  const boundary = buffer.indexOf("\r\n\r\n", "latin1");
  if (boundary < 0 || boundary > MAX_HEADER_BYTES) throw fault("MALFORMED_WARC_RECORD");
  const lines = buffer.subarray(0, boundary).toString("latin1").split("\r\n");
  if (lines.length === 0 || !expectedFirstLine(lines[0])) throw fault("MALFORMED_WARC_RECORD");
  if (lines.length - 1 > MAX_HEADER_FIELDS) throw fault("HEADER_FIELD_LIMIT_EXCEEDED");

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw fault("MALFORMED_WARC_RECORD");
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value) throw fault("MALFORMED_WARC_RECORD");
    const normalizedName = name.toLowerCase();
    if (headers.has(normalizedName)) {
      // WARC records legitimately repeat informational headers (for example
      // WARC-Protocol), and HTTP can repeat Set-Cookie. Only a conflicting
      // framing/security-sensitive duplicate is unsafe; retain the first
      // occurrence for fields this parser actually consumes.
      const existing = headers.get(normalizedName)!;
      if (
        ["content-length", "content-type", "warc-type", "warc-target-uri", "warc-date", "content-encoding", "transfer-encoding"].includes(normalizedName) &&
        existing !== value
      ) {
        throw fault("CONFLICTING_DUPLICATE_HEADER");
      }
      continue;
    }
    headers.set(normalizedName, value);
  }
  return { headers, bodyOffset: boundary + 4 };
}

function requiredHeader(headers: Map<string, string>, headerName: string): string {
  const value = headers.get(headerName);
  if (!value) throw fault("MISSING_WARC_HEADER");
  return value;
}

function parseHeaderByteLength(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw fault("INVALID_WARC_CONTENT_LENGTH");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw fault("INVALID_WARC_CONTENT_LENGTH");
  return parsed;
}

function parseWarcDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw fault("INVALID_WARC_DATE");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw fault("INVALID_WARC_DATE");
  const parsed = new Date(timestamp);
  const canonicalValue = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (parsed.toISOString() !== canonicalValue) throw fault("INVALID_WARC_DATE");
  return parsed;
}

function isWarcHttpResponseType(value: string): boolean {
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  return parts.length === 2 && parts[0] === "application/http" && parts[1] === "msgtype=response";
}

/**
 * Parses exactly one decompressed WARC response record. CDX range records
 * point at individual gzip members, so accepting a second record would make a
 * corrupt range indistinguishable from a valid pointer.
 */
export function parseCommonCrawlWarcResponse(
  payload: Buffer,
  record: CommonCrawlIndexRecord,
  target: NormalizedCommonCrawlTarget,
  maxHtmlBytes: number
): ParsedWarcResponse {
  const warc = parseHeaderBlock(payload, (line) => line === "WARC/1.0" || line === "WARC/1.1");
  if (requiredHeader(warc.headers, "warc-type").toLowerCase() !== "response") throw fault("UNEXPECTED_WARC_TYPE");
  if (!isWarcHttpResponseType(requiredHeader(warc.headers, "content-type"))) throw fault("UNEXPECTED_WARC_CONTENT_TYPE");

  const targetUrl = normalizeArchiveUrl(requiredHeader(warc.headers, "warc-target-uri"));
  const targetHost = new URL(targetUrl).hostname.toLowerCase();
  if (targetHost !== target.hostname || targetUrl !== record.normalizedUrl) throw fault("WARC_TARGET_OUT_OF_SCOPE");
  const captureTimestamp = parseWarcDate(requiredHeader(warc.headers, "warc-date"));
  const warcContentLength = parseHeaderByteLength(requiredHeader(warc.headers, "content-length"));
  const payloadEnd = warc.bodyOffset + warcContentLength;
  if (payloadEnd > payload.length) throw fault("TRUNCATED_WARC_RECORD");
  const trailing = payload.subarray(payloadEnd);
  if (trailing.some((byte) => byte !== 0x0d && byte !== 0x0a)) throw fault("UNEXPECTED_WARC_TRAILING_DATA");

  const httpPayload = payload.subarray(warc.bodyOffset, payloadEnd);
  const http = parseHeaderBlock(httpPayload, (line) => /^HTTP\/1\.[01]\s+200(?:\s|$)/.test(line));
  const contentType = requiredHeader(http.headers, "content-type");
  if (!isHtmlMime(contentType)) throw fault("UNEXPECTED_HTTP_CONTENT_TYPE");
  const contentEncoding = http.headers.get("content-encoding")?.toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") throw fault("UNSUPPORTED_HTTP_CONTENT_ENCODING");
  if (http.headers.has("transfer-encoding")) throw fault("UNSUPPORTED_HTTP_TRANSFER_ENCODING");

  const html = httpPayload.subarray(http.bodyOffset);
  if (html.byteLength > maxHtmlBytes) throw fault("HTML_SIZE_LIMIT_EXCEEDED");
  const declaredHttpLength = http.headers.get("content-length");
  if (declaredHttpLength && parseHeaderByteLength(declaredHttpLength) !== html.byteLength) throw fault("HTTP_CONTENT_LENGTH_MISMATCH");

  return { targetUrl, captureTimestamp, statusCode: 200, contentType, html };
}

async function readStreamWithLimit(
  source: AsyncIterable<unknown> & { destroy?: (error?: Error) => unknown },
  maxBytes: number,
  onBytesReceived?: (bytes: number) => void
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined;
    if (!buffer) throw fault("INVALID_RESPONSE_STREAM");
    bytes += buffer.byteLength;
    try {
      onBytesReceived?.(buffer.byteLength);
    } catch (error) {
      source.destroy?.(error instanceof Error ? error : new Error("response budget"));
      throw error;
    }
    if (bytes > maxBytes) {
      source.destroy?.(new Error("response limit"));
      throw fault("RESPONSE_SIZE_LIMIT_EXCEEDED", false, bytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function decompressGzipWithLimit(
  compressed: Buffer,
  maxBytes: number,
  onBytesReceived?: (bytes: number) => void
): Promise<Buffer> {
  const source = Readable.from([compressed]);
  const gunzip = createGunzip();
  source.pipe(gunzip);
  try {
    return await readStreamWithLimit(gunzip, maxBytes, onBytesReceived);
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (error instanceof ProviderFault) throw error;
    throw fault("CORRUPT_GZIP_RECORD");
  }
}

function parseContentRange(value: string | undefined, expectedStart: number, expectedLength: number): void {
  if (!value) throw fault("MISSING_CONTENT_RANGE");
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) throw fault("INVALID_CONTENT_RANGE");
  const start = canonicalSafeInteger(match[1], true, "INVALID_CONTENT_RANGE");
  const end = canonicalSafeInteger(match[2], true, "INVALID_CONTENT_RANGE");
  const total = canonicalSafeInteger(match[3], false, "INVALID_CONTENT_RANGE");
  const expectedEnd = expectedStart + expectedLength - 1;
  if (start !== expectedStart || end !== expectedEnd || total <= end) throw fault("CONTENT_RANGE_MISMATCH");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Bounds resolver/validation work as well as HTTP I/O. Timed-out work is
 * never reused, so a late DNS answer cannot open a socket after the caller
 * has already failed the crawl.
 */
function withProviderTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutCode: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(fault(timeoutCode, true)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * A fixed-origin HTTPS client. Unlike the live crawler fetcher, no endpoint is
 * derived from remote CDX values and DNS is pinned after the same restricted-IP
 * validation used by the rest of the backend.
 */
class FixedOriginCommonCrawlTransport implements CommonCrawlHttpTransport {
  async get(
    url: URL,
    options: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number; onBytesReceived?: (bytes: number) => void }
  ): Promise<CommonCrawlHttpResponse> {
    const expectedHost = url.hostname.toLowerCase() === INDEX_HOST ? INDEX_HOST : url.hostname.toLowerCase() === DATA_HOST ? DATA_HOST : undefined;
    if (!expectedHost) throw fault("UNSAFE_COMMON_CRAWL_ENDPOINT");
    assertFixedCommonCrawlUrl(url, expectedHost);

    const transportStartedAt = Date.now();
    let records: Array<{ address: string; family: number }>;
    try {
      records = await withProviderTimeout(
        dnsLookup(expectedHost, { all: true, verbatim: true }),
        options.timeoutMs,
        "COMMON_CRAWL_DNS_TIMEOUT"
      );
    } catch (error) {
      if (error instanceof ProviderFault) throw error;
      throw fault("COMMON_CRAWL_DNS_FAILURE", true);
    }
    if (records.length === 0 || records.some((record) => (record.family !== 4 && record.family !== 6) || isBlockedIp(record.address))) {
      throw fault("UNSAFE_COMMON_CRAWL_DNS");
    }
    const selected = records[0];
    const family = selected.family as 4 | 6;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      // Node 22 may request `{ all: true }` for a custom lookup. Supplying a
      // scalar address in that mode produces ERR_INVALID_IP_ADDRESS and would
      // bypass neither the pin nor the timeout policy, so preserve the exact
      // validated address in the shape Node requested.
      callback(
        null,
        options.all ? [{ address: selected.address, family }] : selected.address,
        family
      );
    };

    const remainingTimeoutMs = options.timeoutMs - (Date.now() - transportStartedAt);
    if (remainingTimeoutMs <= 0) throw fault("COMMON_CRAWL_REQUEST_TIMEOUT", true);

    return new Promise<CommonCrawlHttpResponse>((resolve, reject) => {
      const requestOptions: ClientRequestArgs = {
        protocol: "https:",
        hostname: expectedHost,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Accept: "application/json,application/octet-stream;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "identity",
          "User-Agent": "GrowthSentCommonCrawl/1.0",
          ...options.headers,
        },
        lookup,
        agent: false,
      };
      const request = httpsRequest(requestOptions, async (response) => {
        try {
          const declaredLength = parseDeclaredContentLength(response.headers);
          if (declaredLength !== undefined && declaredLength > options.maxBytes) {
            response.destroy();
            throw fault("RESPONSE_SIZE_LIMIT_EXCEEDED");
          }
          const contentEncoding = getHeader(response.headers, "content-encoding")?.toLowerCase();
          if (contentEncoding && contentEncoding !== "identity") {
            response.destroy();
            throw fault("UNEXPECTED_CONTENT_ENCODING");
          }
          const body = await readStreamWithLimit(response, options.maxBytes, options.onBytesReceived);
          resolve({ statusCode: response.statusCode || 0, headers: response.headers, body });
        } catch (error) {
          reject(error);
        }
      });
      const timeout = setTimeout(() => request.destroy(fault("COMMON_CRAWL_REQUEST_TIMEOUT", true)), remainingTimeoutMs);
      request.once("error", (error) => reject(error instanceof ProviderFault ? error : fault("COMMON_CRAWL_NETWORK_FAILURE", true)));
      request.once("close", () => clearTimeout(timeout));
      request.end();
    });
  }
}

function emptyRobotsResult() {
  return {
    exists: false,
    accessible: false,
    statusCode: 0,
    sitemaps: [],
    disallowedPaths: [],
    allowedPaths: [],
    rawText: "",
  };
}

function emptySitemapResult() {
  return {
    exists: false,
    accessible: false,
    statusCode: 0,
    missingConfirmed: false,
    urls: [],
    sitemapIndexUrls: [],
    errors: [],
  };
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function cloneMetrics(metrics: CommonCrawlMetrics): CommonCrawlMetrics {
  return { ...metrics };
}

export function commonCrawlMetricsFromError(error: unknown): CommonCrawlMetrics | undefined {
  return error instanceof CommonCrawlProviderError ? cloneMetrics(error.metrics) : undefined;
}

/**
 * Bounded, WARC-only Common Crawl provider. It never accesses WAT/WET objects
 * and never writes to MongoDB; the durable scan workers own publication.
 */
export class CommonCrawlProvider {
  private readonly limits: CommonCrawlLimits;
  private readonly transport: CommonCrawlHttpTransport;
  private readonly targetValidator: (input: string) => Promise<UrlValidationResult>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly metricsSink?: (metrics: CommonCrawlMetrics) => void;
  private metrics: CommonCrawlMetrics = this.newMetrics();
  private deadline = 0;
  private running = false;

  constructor(options: CommonCrawlProviderOptions = {}) {
    this.limits = resolveLimits(options.limits);
    this.transport = options.transport || new FixedOriginCommonCrawlTransport();
    this.targetValidator = options.targetValidator || validateUrlForScan;
    this.sleep = options.sleep || defaultSleep;
    this.now = options.now || Date.now;
    this.metricsSink = options.metricsSink;
  }

  private newMetrics(): CommonCrawlMetrics {
    return {
      collection: "unknown",
      indexLookupLatencyMs: 0,
      indexRecordsDiscovered: 0,
      s3Requests: 0,
      s3RangeRequests: 0,
      compressedBytesDownloaded: 0,
      decompressedBytesProcessed: 0,
      parsingNormalizationMs: 0,
      failures: 0,
      retries: 0,
    };
  }

  private assertWithinDeadline(): void {
    if (this.now() >= this.deadline) throw fault("COMMON_CRAWL_TOTAL_TIMEOUT", true);
  }

  private remainingTimeout(requestCap: number): number {
    this.assertWithinDeadline();
    return Math.max(1, Math.min(requestCap, this.deadline - this.now()));
  }

  private withinDeadline<T>(operation: Promise<T>): Promise<T> {
    return withProviderTimeout(operation, this.remainingTimeout(this.limits.totalTimeoutMs), "COMMON_CRAWL_TOTAL_TIMEOUT");
  }

  private emitMetrics(): void {
    // Instrumentation must never change crawl correctness or surface a target
    // through a logger failure. The supplied payload is already redacted.
    try {
      this.metricsSink?.(cloneMetrics(this.metrics));
    } catch {
      // no-op
    }
  }

  private accountS3Bytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw fault("INVALID_RESPONSE_SIZE");
    this.metrics.compressedBytesDownloaded += bytes;
    if (this.metrics.compressedBytesDownloaded > this.limits.maxTotalCompressedBytes) {
      throw fault("TOTAL_COMPRESSED_LIMIT_EXCEEDED");
    }
  }

  private accountDecompressedBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw fault("INVALID_RESPONSE_SIZE");
    this.metrics.decompressedBytesProcessed += bytes;
    if (this.metrics.decompressedBytesProcessed > this.limits.maxTotalDecompressedBytes) {
      throw fault("TOTAL_DECOMPRESSED_LIMIT_EXCEEDED");
    }
  }

  private async request(
    url: URL,
    expectedHost: string,
    kind: "index" | "s3",
    maxBytes: number,
    requestTimeoutMs: number,
    headers?: Record<string, string>
  ): Promise<CommonCrawlHttpResponse> {
    assertFixedCommonCrawlUrl(url, expectedHost);
    let lastFault: ProviderFault | undefined;

    for (let attempt = 0; attempt <= this.limits.maxRetries; attempt++) {
      this.assertWithinDeadline();
      if (kind === "s3") {
        this.metrics.s3Requests++;
        this.metrics.s3RangeRequests++;
      }
      let streamedS3Bytes = 0;
      try {
        const response = await this.transport.get(url, {
          headers,
          timeoutMs: this.remainingTimeout(requestTimeoutMs),
          maxBytes,
          onBytesReceived:
            kind === "s3"
              ? (bytes) => {
                  streamedS3Bytes += bytes;
                  this.accountS3Bytes(bytes);
                }
              : undefined,
        });
        this.assertWithinDeadline();
        // Count every fully received S3 response attempt before considering its
        // status or range framing. A 5xx body still consumed archive bandwidth
        // and must therefore consume the per-job budget too.
        if (kind === "s3") {
          if (streamedS3Bytes === 0) this.accountS3Bytes(response.body.byteLength);
          else if (streamedS3Bytes !== response.body.byteLength) throw fault("RESPONSE_BYTE_ACCOUNTING_MISMATCH");
        }
        const declaredLength = parseDeclaredContentLength(response.headers);
        const contentEncoding = getHeader(response.headers, "content-encoding")?.toLowerCase();
        if (declaredLength !== undefined && declaredLength > maxBytes) throw fault("RESPONSE_SIZE_LIMIT_EXCEEDED");
        if (response.body.byteLength > maxBytes) throw fault("RESPONSE_SIZE_LIMIT_EXCEEDED");
        if (contentEncoding && contentEncoding !== "identity") throw fault("UNEXPECTED_CONTENT_ENCODING");
        if (isRetryableStatus(response.statusCode)) {
          lastFault = fault("COMMON_CRAWL_RETRYABLE_STATUS", true);
          if (attempt === this.limits.maxRetries) throw lastFault;
        } else {
          return response;
        }
      } catch (error) {
        const current = error instanceof ProviderFault ? error : fault("COMMON_CRAWL_NETWORK_FAILURE", true);
        // A streamed response can exceed its hard cap before it is materialized
        // as a Buffer. Preserve the bytes already received in the S3 budget
        // and telemetry even though the attempt is rejected immediately.
        if (kind === "s3" && current.observedBytes !== undefined) {
          // `streamedS3Bytes` is scoped to a single attempt and counted before
          // buffering. A cap failure can report a final rejected chunk too.
          // Count only that not-yet-reserved remainder.
          if (current.observedBytes > streamedS3Bytes) {
            this.accountS3Bytes(current.observedBytes - streamedS3Bytes);
          }
        }
        lastFault = current;
        if (!current.retryable || attempt === this.limits.maxRetries) throw current;
      }

      this.metrics.retries++;
      await this.withinDeadline(this.sleep(Math.min(1_000, 100 * 2 ** attempt)));
    }

    throw lastFault || fault("COMMON_CRAWL_NETWORK_FAILURE", true);
  }

  private async discoverLatestCollection(): Promise<CommonCrawlCollection> {
    const response = await this.request(
      new URL(COLLECTION_INFO_URL),
      INDEX_HOST,
      "index",
      this.limits.maxIndexResponseBytes,
      this.limits.collectionLookupTimeoutMs
    );
    if (response.statusCode !== 200) throw fault("COMMON_CRAWL_COLLECTION_LOOKUP_FAILED");
    return parseLatestCommonCrawlCollection(response.body);
  }

  private async lookupIndex(collection: CommonCrawlCollection, target: NormalizedCommonCrawlTarget): Promise<CommonCrawlIndexRecord[]> {
    const endpoint = new URL(collection.cdxApi);
    const lookupValue = target.isExactUrl ? target.normalizedUrl : target.hostname;
    endpoint.searchParams.set("url", lookupValue);
    endpoint.searchParams.set("matchType", target.isExactUrl ? "exact" : "host");
    endpoint.searchParams.set("output", "json");
    endpoint.searchParams.append("filter", "status:200");
    endpoint.searchParams.append("filter", "mime:text/html");
    endpoint.searchParams.set("collapse", "urlkey");
    endpoint.searchParams.set("limit", String(this.limits.maxPages));

    const response = await this.request(
      endpoint,
      INDEX_HOST,
      "index",
      this.limits.maxIndexResponseBytes,
      this.limits.indexLookupTimeoutMs
    );
    if (isNoCapturesIndexResponse(response, lookupValue)) return [];
    if (response.statusCode !== 200) throw fault("COMMON_CRAWL_INDEX_LOOKUP_FAILED");
    return parseCommonCrawlIndexRecords(response.body, target, collection.id, this.limits);
  }

  private async fetchAndNormalizeRecord(
    record: CommonCrawlIndexRecord,
    collection: CommonCrawlCollection,
    target: NormalizedCommonCrawlTarget
  ): Promise<CrawledPageResult> {
    const archiveUrl = new URL(`https://${DATA_HOST}/${record.filename}`);
    assertFixedCommonCrawlUrl(archiveUrl, DATA_HOST);
    const end = record.offset + record.length - 1;
    const response = await this.request(
      archiveUrl,
      DATA_HOST,
      "s3",
      this.limits.maxCompressedBytesPerRange,
      this.limits.rangeTimeoutMs,
      { Range: `bytes=${record.offset}-${end}` }
    );
    if (response.statusCode !== 206) throw fault("UNEXPECTED_RANGE_STATUS");
    parseContentRange(getHeader(response.headers, "content-range"), record.offset, record.length);
    const declaredLength = parseDeclaredContentLength(response.headers);
    if (declaredLength !== undefined && declaredLength !== record.length) throw fault("RANGE_CONTENT_LENGTH_MISMATCH");
    if (response.body.byteLength !== record.length) throw fault("TRUNCATED_OR_EXPANDED_RANGE");
    const decompressed = await this.withinDeadline(
      decompressGzipWithLimit(response.body, this.limits.maxDecompressedBytesPerRecord, (bytes) => this.accountDecompressedBytes(bytes))
    );

    const normalizationStartedAt = this.now();
    this.assertWithinDeadline();
    const parsed = parseCommonCrawlWarcResponse(decompressed, record, target, this.limits.maxHtmlBytesPerPage);
    const parsedData = parsePageHtml(parsed.html.toString("utf8"), parsed.targetUrl);
    this.assertWithinDeadline();
    this.metrics.parsingNormalizationMs += Math.max(0, this.now() - normalizationStartedAt);
    const provenance: CommonCrawlPageProvenance = {
      source: "common-crawl",
      collection: collection.id,
      warcFilename: record.filename,
      warcOffset: record.offset,
      warcLength: record.length,
      cdxTimestamp: record.timestamp,
      captureTimestamp: parsed.captureTimestamp,
    };

    return {
      url: parsed.targetUrl,
      normalizedUrl: parsed.targetUrl,
      statusCode: parsed.statusCode,
      // Archive fetch latency is not an origin response measurement.
      responseTimeMs: 0,
      contentType: parsed.contentType,
      pageSizeBytes: parsed.html.byteLength,
      parsedData,
      hasRobotsTxtDisallow: false,
      provenance,
    };
  }

  private async fetchRecords(
    records: CommonCrawlIndexRecord[],
    collection: CommonCrawlCollection,
    target: NormalizedCommonCrawlTarget
  ): Promise<CrawledPageResult[]> {
    const output: CrawledPageResult[] = new Array(records.length);
    let nextIndex = 0;
    let firstFailure: unknown;
    const worker = async () => {
      while (!firstFailure) {
        const index = nextIndex++;
        if (index >= records.length) return;
        try {
          output[index] = await this.fetchAndNormalizeRecord(records[index], collection, target);
        } catch (error) {
          firstFailure = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.maxConcurrency, records.length) }, worker));
    if (firstFailure) throw firstFailure;
    return output;
  }

  /** Returns GrowthSent's existing crawl result shape and performs no persistence. */
  async crawl(inputUrl: string, options: CrawlEngineOptions = {}): Promise<CrawlExecutionResult> {
    if (this.running) {
      throw new CommonCrawlProviderError("CONCURRENT_PROVIDER_USE", false, this.newMetrics());
    }
    this.running = true;
    this.metrics = this.newMetrics();
    const startedAt = this.now();
    this.deadline = startedAt + this.limits.totalTimeoutMs;
    try {
      const target = await this.withinDeadline(normalizeAndValidateCommonCrawlTarget(inputUrl, this.targetValidator));
      const indexStartedAt = this.now();
      let collection: CommonCrawlCollection;
      let indexRecords: CommonCrawlIndexRecord[];
      try {
        collection = await this.discoverLatestCollection();
        this.metrics.collection = collection.id;
        indexRecords = await this.lookupIndex(collection, target);
      } finally {
        this.metrics.indexLookupLatencyMs = Math.max(0, this.now() - indexStartedAt);
      }
      this.metrics.indexRecordsDiscovered = indexRecords.length;

      const requestedPages = Number.isFinite(options.maxPages) ? Math.max(1, Math.floor(options.maxPages as number)) : this.limits.maxPages;
      const selected = indexRecords.slice(0, Math.min(requestedPages, this.limits.maxPages));
      const pages = selected.length > 0 ? await this.fetchRecords(selected, collection, target) : [];
      const statusCodesCount: Record<string, number> = {};
      for (const page of pages) {
        const status = String(page.statusCode);
        statusCodesCount[status] = (statusCodesCount[status] || 0) + 1;
      }

      const capabilities: CrawlProviderCapabilities = {
        supportsSiteDiscovery: false,
        supportsResponseTiming: false,
      };
      const result: CrawlExecutionResult = {
        startUrl: target.normalizedUrl,
        hostname: target.hostname,
        durationMs: Math.max(0, this.now() - startedAt),
        totalPagesCrawled: pages.length,
        bytesDownloaded: this.metrics.compressedBytesDownloaded,
        statusCodesCount,
        robots: emptyRobotsResult(),
        sitemap: emptySitemapResult(),
        pages,
        provider: "common-crawl",
        capabilities,
        commonCrawlMetrics: cloneMetrics(this.metrics),
      };
      this.emitMetrics();
      return result;
    } catch (error) {
      this.metrics.failures++;
      const wrapped = error instanceof ProviderFault
        ? new CommonCrawlProviderError(error.code, error.retryable, cloneMetrics(this.metrics))
        : error instanceof CommonCrawlProviderError
          ? error
          : new CommonCrawlProviderError("COMMON_CRAWL_UNEXPECTED_FAILURE", false, cloneMetrics(this.metrics));
      this.emitMetrics();
      throw wrapped;
    } finally {
      this.running = false;
    }
  }
}
