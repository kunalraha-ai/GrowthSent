/**
 * Source metadata shared by crawl providers and the active MongoDB documents.
 * These types deliberately extend the existing crawl/page representation; they
 * do not introduce a second persistence model for archive data.
 */
export type CrawlDataProviderName = "live" | "common-crawl";

export interface CrawlProviderCapabilities {
  /** Whether robots.txt and sitemap assertions were observed for this crawl. */
  supportsSiteDiscovery: boolean;
  /** Whether page response time represents an origin response measurement. */
  supportsResponseTiming: boolean;
}

export interface CommonCrawlPageProvenance {
  source: "common-crawl";
  collection: string;
  warcFilename: string;
  warcOffset: number;
  warcLength: number;
  cdxTimestamp: string;
  captureTimestamp: Date;
}

/**
 * Redacted operational measurements. They intentionally contain no target
 * URL, response body, headers, or remote error text.
 */
export interface CommonCrawlMetrics {
  collection: string;
  indexLookupLatencyMs: number;
  indexRecordsDiscovered: number;
  s3Requests: number;
  s3RangeRequests: number;
  compressedBytesDownloaded: number;
  decompressedBytesProcessed: number;
  parsingNormalizationMs: number;
  failures: number;
  retries: number;
}
