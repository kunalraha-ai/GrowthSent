import { fetchUrl, FetchResult, type FetchFailureCategory } from "./fetcher.js";
import { fetchAndParseRobotsTxt, isPathDisallowedByRobots, RobotsTxtResult } from "./robots.js";
import { fetchAndParseSitemap, SitemapParseResult } from "./sitemap.js";
import { parsePageHtml, ParsedPageData } from "./parser.js";
import { isUrlWithinCrawlOriginScope } from "../domain/registrable.js";
import type {
  CommonCrawlMetrics,
  CommonCrawlPageProvenance,
  CrawlDataProviderName,
  CrawlProviderCapabilities,
} from "./types.js";

export interface CrawledPageResult {
  url: string;
  normalizedUrl: string;
  statusCode: number;
  responseTimeMs: number;
  contentType: string;
  pageSizeBytes: number;
  /** Safe fetch failure classification; the raw transport error is never exposed. */
  fetchFailureCategory?: FetchFailureCategory;
  error?: string;
  parsedData?: ParsedPageData;
  hasRobotsTxtDisallow: boolean;
  /** Present only when an archive provider supplied this existing page result. */
  provenance?: CommonCrawlPageProvenance;
}

export interface CrawlEngineOptions {
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  timeoutMs?: number;
}

export interface CrawlExecutionResult {
  startUrl: string;
  hostname: string;
  durationMs: number;
  totalPagesCrawled: number;
  bytesDownloaded: number;
  statusCodesCount: Record<string, number>;
  robots: RobotsTxtResult;
  sitemap: SitemapParseResult;
  pages: CrawledPageResult[];
  /** Omitted for legacy callers; live crawl results populate it. */
  provider?: CrawlDataProviderName;
  /** Prevent source-incompatible SEO assertions for archive-only captures. */
  capabilities?: CrawlProviderCapabilities;
  /** Redacted Common Crawl measurements, retained through the normal scan record. */
  commonCrawlMetrics?: CommonCrawlMetrics;
}

export interface RootPageEvaluation {
  evaluable: boolean;
  statusCode?: number;
  failureCategory?: FetchFailureCategory | "missing_root_result" | "non_html_response" | "unexpected_http_status";
}

/**
 * A technical audit can only score the site when the requested root page was
 * actually retrieved as HTML. This is deliberately stricter than a generic
 * HTTP success: a response body that was rejected or could not be parsed is
 * not evidence for metadata or indexability conclusions.
 */
export function evaluateRootPage(crawl: CrawlExecutionResult): RootPageEvaluation {
  const root = crawl.pages.find((page) => page.url === crawl.startUrl);
  if (!root) return { evaluable: false, failureCategory: "missing_root_result" };
  if (root.fetchFailureCategory) {
    return { evaluable: false, statusCode: root.statusCode, failureCategory: root.fetchFailureCategory };
  }
  if (root.statusCode !== 200) {
    return { evaluable: false, statusCode: root.statusCode, failureCategory: "unexpected_http_status" };
  }
  if (!root.contentType.toLowerCase().includes("html") || !root.parsedData) {
    return { evaluable: false, statusCode: root.statusCode, failureCategory: "non_html_response" };
  }
  return { evaluable: true, statusCode: root.statusCode };
}

export async function runCrawl(
  startUrl: string,
  options: CrawlEngineOptions = {}
): Promise<CrawlExecutionResult> {
  const startTime = Date.now();
  const maxPages = options.maxPages ?? 25;
  const maxDepth = options.maxDepth ?? 5;
  const concurrency = options.concurrency ?? 5;
  const timeoutMs = options.timeoutMs ?? 5000;

  const parsedStart = new URL(startUrl);
  const hostname = parsedStart.hostname.toLowerCase();

  // Fetch robots first so declared sitemap locations can be honored safely.
  // sitemap.ts enforces the audited site's www/apex scope before any fetch.
  const robots = await fetchAndParseRobotsTxt(startUrl);
  const sitemap = await fetchAndParseSitemap(startUrl, robots.sitemaps);

  // Queue & visited state
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const visited = new Set<string>();
  const pages: CrawledPageResult[] = [];
  const statusCodesCount: Record<string, number> = {};
  let totalBytesDownloaded = 0;

  // Sitemap URLs must stay within the narrow original www/apex crawl scope.
  for (const sitemapPageUrl of sitemap.urls) {
    if (isUrlWithinCrawlOriginScope(startUrl, sitemapPageUrl) && queue.length < maxPages) {
      queue.push({ url: sitemapPageUrl, depth: 1 });
    }
  }

  while (queue.length > 0 && pages.length < maxPages) {
    // Take up to `concurrency` unvisited items from queue
    const batch: Array<{ url: string; depth: number }> = [];
    while (queue.length > 0 && batch.length < concurrency && pages.length + batch.length < maxPages) {
      const item = queue.shift()!;
      if (!visited.has(item.url) && item.depth <= maxDepth) {
        visited.add(item.url);
        batch.push(item);
      }
    }

    if (batch.length === 0) continue;

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (current) => {
        const path = new URL(current.url).pathname;
        const isDisallowed = isPathDisallowedByRobots(path, robots.disallowedPaths, robots.allowedPaths);

        if (isDisallowed) {
          return {
            page: {
              url: current.url,
              normalizedUrl: current.url,
              statusCode: 403,
              responseTimeMs: 0,
              contentType: "",
              pageSizeBytes: 0,
              error: "Blocked by robots.txt Disallow directive.",
              hasRobotsTxtDisallow: true,
            },
            discoveredLinks: [] as string[],
            depth: current.depth,
          };
        }

        const fetchRes: FetchResult = await fetchUrl(current.url, { timeoutMs });
        let parsedData: ParsedPageData | undefined = undefined;
        let discoveredLinks: string[] = [];

        if (fetchRes.statusCode === 200 && fetchRes.body && fetchRes.contentType.includes("html")) {
          parsedData = parsePageHtml(fetchRes.body, fetchRes.finalUrl);
          // A redirect may safely retrieve the requested resource, but it may
          // not turn a different public host into new recursive crawl scope.
          discoveredLinks = (parsedData.internalLinks || []).filter((link) =>
            isUrlWithinCrawlOriginScope(startUrl, link)
          );
        }

        return {
          page: {
            url: current.url,
            normalizedUrl: fetchRes.finalUrl,
            statusCode: fetchRes.statusCode,
            responseTimeMs: fetchRes.responseTimeMs,
            contentType: fetchRes.contentType,
            pageSizeBytes: fetchRes.pageSizeBytes,
            fetchFailureCategory: fetchRes.failureCategory,
            error: fetchRes.error,
            parsedData,
            hasRobotsTxtDisallow: false,
          },
          discoveredLinks,
          depth: current.depth,
        };
      })
    );

    for (const result of batchResults) {
      pages.push(result.page);
      totalBytesDownloaded += result.page.pageSizeBytes;
      const codeKey = result.page.statusCode.toString();
      statusCodesCount[codeKey] = (statusCodesCount[codeKey] || 0) + 1;

      // Enqueue discovered internal links if under limits
      if (result.depth + 1 <= maxDepth) {
        for (const internalLink of result.discoveredLinks) {
          if (!visited.has(internalLink) && pages.length + queue.length < maxPages * 2) {
            queue.push({ url: internalLink, depth: result.depth + 1 });
          }
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    startUrl,
    hostname,
    durationMs,
    totalPagesCrawled: pages.length,
    bytesDownloaded: totalBytesDownloaded,
    statusCodesCount,
    robots,
    sitemap,
    pages,
    provider: "live",
    capabilities: {
      supportsSiteDiscovery: true,
      supportsResponseTiming: true,
    },
  };
}
