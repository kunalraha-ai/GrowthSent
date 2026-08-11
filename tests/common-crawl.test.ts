import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CommonCrawlProvider,
  CommonCrawlProviderError,
  type CommonCrawlHttpTransport,
  parseCommonCrawlIndexRecords,
  parseCommonCrawlWarcResponse,
  parseLatestCommonCrawlCollection,
  normalizeAndValidateCommonCrawlTarget,
  type CommonCrawlIndexRecord,
  type NormalizedCommonCrawlTarget,
} from "../lib/crawler/providers/common-crawl";
import { shouldRetryDurableCrawlAttempt } from "../lib/crawler/provider";
import { CommonCrawlAdmissionError } from "../lib/crawler/common-crawl-admission";
import { createCommonCrawlRequesterKey } from "../lib/security/common-crawl-requester";
import type { CommonCrawlMetrics } from "../lib/crawler/types";

const COLLECTION = "CC-MAIN-2026-30";
const TARGET: NormalizedCommonCrawlTarget = {
  normalizedUrl: "https://example.com/page",
  hostname: "example.com",
  isExactUrl: true,
};

function targetValidator(input: string) {
  return async () => ({
    isValid: true,
    normalizedUrl: input,
    hostname: new URL(input).hostname.toLowerCase(),
    resolvedAddress: { address: "93.184.216.34", family: 4 as const },
  });
}

function collectionBody(): Buffer {
  return Buffer.from(
    JSON.stringify([
      {
        id: COLLECTION,
        to: "2026-07-31T00:00:00Z",
        "cdx-api": `https://index.commoncrawl.org/${COLLECTION}-index`,
      },
      {
        id: "CC-MAIN-2026-22",
        to: "2026-06-01T00:00:00Z",
        "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-22-index",
      },
    ])
  );
}

function warcFilename(): string {
  return `crawl-data/${COLLECTION}/segments/1760000000000.1/warc/CC-MAIN-20260731000000-20260731030000-00001.warc.gz`;
}

function buildWarcGzip(url = TARGET.normalizedUrl, html = "<html><head><title>Archive page</title></head><body><h1>Archived</h1></body></html>"): Buffer {
  const htmlBuffer = Buffer.from(html, "utf8");
  const http = Buffer.concat([
    Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${htmlBuffer.byteLength}\r\n\r\n`,
      "latin1"
    ),
    htmlBuffer,
  ]);
  const warc = Buffer.concat([
    Buffer.from(
      `WARC/1.0\r\nWARC-Type: response\r\nWARC-Date: 2026-07-31T01:02:03Z\r\nWARC-Target-URI: ${url}\r\nContent-Type: application/http; msgtype=response\r\nContent-Length: ${http.byteLength}\r\n\r\n`,
      "latin1"
    ),
    http,
    Buffer.from("\r\n\r\n", "latin1"),
  ]);
  return gzipSync(warc);
}

function cdxLine(length: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: TARGET.normalizedUrl,
    timestamp: "20260731010203",
    mime: "text/html",
    status: "200",
    filename: warcFilename(),
    offset: "10",
    length: String(length),
    ...overrides,
  });
}

function parsedRecord(length = 100): CommonCrawlIndexRecord {
  return parseCommonCrawlIndexRecords(Buffer.from(`${cdxLine(length)}\n`), TARGET, COLLECTION, {
    maxPages: 10,
    maxIndexLineBytes: 16 * 1024,
    maxCompressedBytesPerRange: 1024 * 1024,
  })[0];
}

function happyTransport(
  compressed: Buffer,
  options: {
    rangeHeader?: string;
    failFirstIndex?: boolean;
    failFirstRange?: boolean;
    expandRange?: boolean;
    rangeStatus?: number;
  } = {}
): CommonCrawlHttpTransport {
  let indexCalls = 0;
  let rangeCalls = 0;
  return {
    async get(url, requestOptions) {
      if (url.pathname === "/collinfo.json") {
        return { statusCode: 200, headers: { "content-length": String(collectionBody().byteLength) }, body: collectionBody() };
      }
      if (url.hostname === "index.commoncrawl.org") {
        indexCalls++;
        if (options.failFirstIndex && indexCalls === 1) throw new Error("simulated network timeout");
        const body = Buffer.from(`${cdxLine(compressed.byteLength)}\n`);
        return { statusCode: 200, headers: { "content-length": String(body.byteLength) }, body };
      }
      rangeCalls++;
      if (options.failFirstRange && rangeCalls === 1) {
        const retryBody = Buffer.from("temporary upstream failure", "utf8");
        return {
          statusCode: 503,
          headers: { "content-length": String(retryBody.byteLength) },
          body: retryBody,
        };
      }
      const body = options.expandRange ? Buffer.concat([compressed, Buffer.from([0])]) : compressed;
      return {
        statusCode: options.rangeStatus || 206,
        headers: {
          "content-range": options.rangeHeader || `bytes 10-${10 + compressed.byteLength - 1}/${compressed.byteLength + 100}`,
          "content-length": String(body.byteLength),
        },
        body,
      };
    },
  };
}

function metrics(): CommonCrawlMetrics {
  return {
    collection: COLLECTION,
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

test("Common Crawl normalizes validated target URLs and rejects unsafe archive input", async () => {
  const target = await normalizeAndValidateCommonCrawlTarget(
    "https://Example.COM/path#fragment",
    targetValidator("https://Example.COM/path#fragment")
  );
  assert.equal(target.normalizedUrl, "https://example.com/path");
  assert.equal(target.hostname, "example.com");
  assert.equal(target.isExactUrl, true);

  await assert.rejects(
    normalizeAndValidateCommonCrawlTarget("https://user:password@example.com/", targetValidator("https://user:password@example.com/")),
    /UNSAFE_ARCHIVE_URL/
  );
  await assert.rejects(
    normalizeAndValidateCommonCrawlTarget("https://example.com/", async () => ({ isValid: false })),
    /UNSAFE_TARGET_URL/
  );
});

test("archive admission identities are non-reversible HMACs and terminal identity faults do not retry", () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  try {
    const userKey = createCommonCrawlRequesterKey({ userId: "0123456789abcdef01234567" });
    const ipKey = createCommonCrawlRequesterKey({ requestIp: "203.0.113.7" });
    assert.match(userKey, /^ccr_[a-f0-9]{64}$/);
    assert.match(ipKey, /^ccr_[a-f0-9]{64}$/);
    assert.notEqual(userKey, ipKey);
    assert.equal(userKey.includes("0123456789abcdef01234567"), false);
    assert.equal(ipKey.includes("203.0.113.7"), false);
    assert.throws(() => createCommonCrawlRequesterKey({ requestIp: "not-an-ip" }), /requester IP is invalid/);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }

  assert.equal(
    shouldRetryDurableCrawlAttempt(1, 3, new CommonCrawlAdmissionError("COMMON_CRAWL_ADMISSION_IDENTITY_INVALID", false)),
    false
  );
});

test("collection and CDX parsers reject malformed records, unsafe keys, and overflowing ranges", () => {
  const latest = parseLatestCommonCrawlCollection(collectionBody());
  assert.equal(latest.id, COLLECTION);
  assert.equal(latest.cdxApi, `https://index.commoncrawl.org/${COLLECTION}-index`);
  assert.throws(() => parseLatestCommonCrawlCollection(Buffer.from("{}")), /MALFORMED_COLLECTION_LIST/);

  const records = parseCommonCrawlIndexRecords(Buffer.from(`${cdxLine(100)}\n`), TARGET, COLLECTION, {
    maxPages: 10,
    maxIndexLineBytes: 16 * 1024,
    maxCompressedBytesPerRange: 1024,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].offset, 10);

  const scoped = parseCommonCrawlIndexRecords(
    Buffer.from(`${cdxLine(100, { url: "https://www.example.com/page" })}\n${cdxLine(100)}\n`),
    TARGET,
    COLLECTION,
    { maxPages: 10, maxIndexLineBytes: 16 * 1024, maxCompressedBytesPerRange: 1024 }
  );
  assert.equal(scoped.length, 1, "canonical aliases are validated then excluded before any range request");
  assert.equal(scoped[0].normalizedUrl, TARGET.normalizedUrl);

  assert.throws(
    () =>
      parseCommonCrawlIndexRecords(Buffer.from(`${cdxLine(100, { offset: "9007199254740992" })}\n`), TARGET, COLLECTION, {
        maxPages: 10,
        maxIndexLineBytes: 16 * 1024,
        maxCompressedBytesPerRange: 1024,
      }),
    /INVALID_CDX_OFFSET/
  );
  assert.throws(
    () =>
      parseCommonCrawlIndexRecords(Buffer.from(`${cdxLine(100, { filename: "../../secrets.warc.gz" })}\n`), TARGET, COLLECTION, {
        maxPages: 10,
        maxIndexLineBytes: 16 * 1024,
        maxCompressedBytesPerRange: 1024,
      }),
    /INVALID_WARC_FILENAME/
  );
  assert.throws(
    () =>
      parseCommonCrawlIndexRecords(Buffer.from('{"url":"https://example.com/page"}\n'), TARGET, COLLECTION, {
        maxPages: 10,
        maxIndexLineBytes: 16 * 1024,
        maxCompressedBytesPerRange: 1024,
      }),
    /MALFORMED_CDX_RECORD/
  );
});

test("WARC parsing accepts one bounded response record and rejects corrupt payloads", () => {
  const compressed = buildWarcGzip();
  const record = parsedRecord(compressed.byteLength);
  const decompressed = gunzipSync(compressed);
  const parsed = parseCommonCrawlWarcResponse(decompressed, record, TARGET, 2 * 1024 * 1024);
  assert.equal(parsed.statusCode, 200);
  assert.equal(parsed.targetUrl, TARGET.normalizedUrl);
  assert.match(parsed.html.toString("utf8"), /Archive page/);

  const invalid = Buffer.from("WARC/1.0\r\nWARC-Type: response\r\n\r\nnot-a-response", "latin1");
  assert.throws(() => parseCommonCrawlWarcResponse(invalid, record, TARGET, 1024), /MISSING_WARC_HEADER|MALFORMED_WARC_RECORD/);

  const permissiveContentType = Buffer.from(
    decompressed.toString("latin1").replace("application/http; msgtype=response", "message/http"),
    "latin1"
  );
  assert.throws(
    () => parseCommonCrawlWarcResponse(permissiveContentType, record, TARGET, 2 * 1024 * 1024),
    /UNEXPECTED_WARC_CONTENT_TYPE/
  );

  const nonCanonicalDate = Buffer.from(
    decompressed.toString("latin1").replace("2026-07-31T01:02:03Z", "2026-07-31T01:02:03.1Z"),
    "latin1"
  );
  assert.throws(
    () => parseCommonCrawlWarcResponse(nonCanonicalDate, record, TARGET, 2 * 1024 * 1024),
    /INVALID_WARC_DATE/
  );
});

test("provider range-fetches only indexed bytes and maps archive provenance into GrowthSent pages", async () => {
  const compressed = buildWarcGzip();
  const provider = new CommonCrawlProvider({
    transport: happyTransport(compressed),
    targetValidator: targetValidator(TARGET.normalizedUrl),
  });
  const result = await provider.crawl(TARGET.normalizedUrl);

  assert.equal(result.provider, "common-crawl");
  assert.equal(result.capabilities?.supportsSiteDiscovery, false);
  assert.equal(result.capabilities?.supportsResponseTiming, false);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].parsedData?.title, "Archive page");
  assert.equal(result.pages[0].responseTimeMs, 0);
  assert.equal(result.pages[0].provenance?.collection, COLLECTION);
  assert.equal(result.pages[0].provenance?.warcLength, compressed.byteLength);
  assert.equal(result.commonCrawlMetrics?.s3Requests, 1);
  assert.equal(result.commonCrawlMetrics?.s3RangeRequests, 1);
  assert.equal(result.commonCrawlMetrics?.compressedBytesDownloaded, compressed.byteLength);
});

test("a strict Common Crawl no-captures response is a successful empty crawl", async () => {
  const noCapturesTransport: CommonCrawlHttpTransport = {
    async get(url) {
      if (url.pathname === "/collinfo.json") {
        return { statusCode: 200, headers: {}, body: collectionBody() };
      }
      return {
        statusCode: 404,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ message: "No Captures found for: example.com" })),
      };
    },
  };
  const provider = new CommonCrawlProvider({
    transport: noCapturesTransport,
    targetValidator: targetValidator("https://example.com/"),
  });
  const result = await provider.crawl("https://example.com/");
  assert.equal(result.pages.length, 0);
  assert.equal(result.commonCrawlMetrics?.indexRecordsDiscovered, 0);
  assert.equal(result.commonCrawlMetrics?.s3RangeRequests, 0);

  const malformedNoCapturesTransport: CommonCrawlHttpTransport = {
    async get(url) {
      if (url.pathname === "/collinfo.json") return { statusCode: 200, headers: {}, body: collectionBody() };
      return {
        statusCode: 404,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ message: "No Captures found for: other.example" })),
      };
    },
  };
  await assert.rejects(
    new CommonCrawlProvider({
      transport: malformedNoCapturesTransport,
      targetValidator: targetValidator("https://example.com/"),
    }).crawl("https://example.com/"),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "COMMON_CRAWL_INDEX_LOOKUP_FAILED"
  );
});

test("provider fails closed on byte-range mismatches and compressed/decompressed limits", async () => {
  const compressed = buildWarcGzip();
  const mismatchedRange = new CommonCrawlProvider({
    transport: happyTransport(compressed, { rangeHeader: `bytes 11-${10 + compressed.byteLength - 1}/${compressed.byteLength + 100}` }),
    targetValidator: targetValidator(TARGET.normalizedUrl),
  });
  await assert.rejects(
    mismatchedRange.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "CONTENT_RANGE_MISMATCH" && error.retryable === false
  );

  const expandedRange = new CommonCrawlProvider({
    transport: happyTransport(compressed, { expandRange: true }),
    targetValidator: targetValidator(TARGET.normalizedUrl),
  });
  await assert.rejects(
    expandedRange.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "RANGE_CONTENT_LENGTH_MISMATCH"
  );

  const compressedLimit = new CommonCrawlProvider({
    transport: happyTransport(compressed),
    targetValidator: targetValidator(TARGET.normalizedUrl),
    limits: { maxCompressedBytesPerRange: compressed.byteLength - 1 },
  });
  await assert.rejects(
    compressedLimit.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "INVALID_CDX_RANGE"
  );

  const redirectRange = new CommonCrawlProvider({
    transport: happyTransport(compressed, { rangeStatus: 302 }),
    targetValidator: targetValidator(TARGET.normalizedUrl),
  });
  await assert.rejects(
    redirectRange.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "UNEXPECTED_RANGE_STATUS"
  );

  const corruptGzip = new CommonCrawlProvider({
    transport: happyTransport(Buffer.from("not a gzip member")),
    targetValidator: targetValidator(TARGET.normalizedUrl),
  });
  await assert.rejects(
    corruptGzip.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "CORRUPT_GZIP_RECORD"
  );

  const decompressionLimit = new CommonCrawlProvider({
    transport: happyTransport(compressed),
    targetValidator: targetValidator(TARGET.normalizedUrl),
    limits: { maxDecompressedBytesPerRecord: 64 },
  });
  await assert.rejects(
    decompressionLimit.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "RESPONSE_SIZE_LIMIT_EXCEEDED"
  );

  const compressedTotalLimit = new CommonCrawlProvider({
    transport: happyTransport(compressed),
    targetValidator: targetValidator(TARGET.normalizedUrl),
    limits: { maxTotalCompressedBytes: compressed.byteLength - 1 },
  });
  await assert.rejects(
    compressedTotalLimit.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "TOTAL_COMPRESSED_LIMIT_EXCEEDED"
  );

  const decompressedTotalLimit = new CommonCrawlProvider({
    transport: happyTransport(compressed),
    targetValidator: targetValidator(TARGET.normalizedUrl),
    limits: { maxTotalDecompressedBytes: 64 },
  });
  await assert.rejects(
    decompressedTotalLimit.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "TOTAL_DECOMPRESSED_LIMIT_EXCEEDED"
  );
});

test("transient provider faults retry within bounded timeout policy while corrupt data is terminal", async () => {
  const compressed = buildWarcGzip();
  let sleeps = 0;
  const retrying = new CommonCrawlProvider({
    transport: happyTransport(compressed, { failFirstIndex: true }),
    targetValidator: targetValidator(TARGET.normalizedUrl),
    sleep: async () => {
      sleeps++;
    },
  });
  const result = await retrying.crawl(TARGET.normalizedUrl);
  assert.equal(sleeps, 1);
  assert.equal(result.commonCrawlMetrics?.retries, 1);

  const rangeRetry = new CommonCrawlProvider({
    transport: happyTransport(compressed, { failFirstRange: true }),
    targetValidator: targetValidator(TARGET.normalizedUrl),
    sleep: async () => undefined,
  });
  const rangeRetryResult = await rangeRetry.crawl(TARGET.normalizedUrl);
  assert.equal(rangeRetryResult.commonCrawlMetrics?.s3Requests, 2);
  assert.equal(
    rangeRetryResult.commonCrawlMetrics?.compressedBytesDownloaded,
    compressed.byteLength + Buffer.byteLength("temporary upstream failure")
  );

  let clock = 0;
  const totalTimeout = new CommonCrawlProvider({
    transport: {
      async get() {
        clock = 2;
        return { statusCode: 200, headers: {}, body: collectionBody() };
      },
    },
    targetValidator: targetValidator(TARGET.normalizedUrl),
    now: () => clock,
    limits: { totalTimeoutMs: 1 },
  });
  await assert.rejects(
    totalTimeout.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "COMMON_CRAWL_TOTAL_TIMEOUT" && error.retryable === true
  );

  const stalledValidation = new CommonCrawlProvider({
    transport: happyTransport(compressed),
    targetValidator: async () => new Promise(() => undefined),
    limits: { totalTimeoutMs: 5 },
  });
  await assert.rejects(
    stalledValidation.crawl(TARGET.normalizedUrl),
    (error: unknown) => error instanceof CommonCrawlProviderError && error.code === "COMMON_CRAWL_TOTAL_TIMEOUT" && error.retryable === true
  );

  assert.equal(shouldRetryDurableCrawlAttempt(1, 3, new CommonCrawlProviderError("CORRUPT_WARC", false, metrics())), false);
  assert.equal(shouldRetryDurableCrawlAttempt(1, 3, new CommonCrawlProviderError("NETWORK", true, metrics())), true);
  assert.equal(shouldRetryDurableCrawlAttempt(3, 3, new Error("other")), false);
});
