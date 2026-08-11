import { runCrawl, type CrawlEngineOptions, type CrawlExecutionResult } from "./crawler.js";
import { CommonCrawlAdmissionError } from "./common-crawl-admission.js";
import { CommonCrawlProvider, CommonCrawlProviderError } from "./providers/common-crawl.js";
import type { CrawlDataProviderName } from "./types.js";

export interface CrawlDataProvider {
  readonly name: CrawlDataProviderName;
  crawl(inputUrl: string, options?: CrawlEngineOptions): Promise<CrawlExecutionResult>;
}

class LiveCrawlProvider implements CrawlDataProvider {
  readonly name = "live" as const;

  crawl(inputUrl: string, options: CrawlEngineOptions = {}): Promise<CrawlExecutionResult> {
    return runCrawl(inputUrl, options);
  }
}

class CommonCrawlDataProvider implements CrawlDataProvider {
  readonly name = "common-crawl" as const;

  crawl(inputUrl: string, options: CrawlEngineOptions = {}): Promise<CrawlExecutionResult> {
    // A new bounded provider is created per durable job so no target-specific
    // state or telemetry can cross tenant/job boundaries in memory.
    return new CommonCrawlProvider().crawl(inputUrl, options);
  }
}

export function getConfiguredCrawlProviderName(value = process.env.CRAWL_DATA_PROVIDER): CrawlDataProviderName {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "live") return "live";
  if (normalized === "common-crawl") return "common-crawl";
  // Configuration errors fail closed rather than silently changing a queued
  // job's source or falling back to a different network policy.
  throw new Error("CRAWL_DATA_PROVIDER must be either live or common-crawl.");
}

/** Historical documents created before provider selection are live crawls. */
export function resolvePersistedCrawlProvider(value: unknown): CrawlDataProviderName {
  if (value === undefined || value === null || value === "live") return "live";
  if (value === "common-crawl") return "common-crawl";
  throw new Error("Queued crawl has an unsupported provider.");
}

export function getCrawlDataProvider(name: CrawlDataProviderName): CrawlDataProvider {
  if (name === "common-crawl") return new CommonCrawlDataProvider();
  return new LiveCrawlProvider();
}

/**
 * Worker-only dispatch seam. API handlers never call it: they only persist the
 * server-selected provider name while creating their existing durable jobs.
 */
export function runCrawlWithProvider(
  providerName: CrawlDataProviderName,
  inputUrl: string,
  options: CrawlEngineOptions = {}
): Promise<CrawlExecutionResult> {
  return getCrawlDataProvider(providerName).crawl(inputUrl, options);
}

/**
 * Shared worker-state decision: malformed archive data is terminal, while
 * explicitly transient provider errors retain the existing durable retries.
 */
export function shouldRetryDurableCrawlAttempt(attempts: number, maxAttempts: number, error: unknown): boolean {
  if (attempts >= maxAttempts) return false;
  if (error instanceof CommonCrawlProviderError || error instanceof CommonCrawlAdmissionError) return error.retryable;
  return true;
}
