import { fetchUrl, FetchResult } from "./fetcher.js";
import { fetchAndParseRobotsTxt, isPathDisallowedByRobots, RobotsTxtResult } from "./robots.js";
import { fetchAndParseSitemap, SitemapParseResult } from "./sitemap.js";
import { parsePageHtml, ParsedPageData } from "./parser.js";

export interface CrawledPageResult {
  url: string;
  normalizedUrl: string;
  statusCode: number;
  responseTimeMs: number;
  contentType: string;
  pageSizeBytes: number;
  error?: string;
  parsedData?: ParsedPageData;
  hasRobotsTxtDisallow: boolean;
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
}

export async function runCrawl(
  startUrl: string,
  options: CrawlEngineOptions = {}
): Promise<CrawlExecutionResult> {
  const startTime = Date.now();
  const maxPages = options.maxPages ?? 50;
  const maxDepth = options.maxDepth ?? 5;

  const parsedStart = new URL(startUrl);
  const hostname = parsedStart.hostname.toLowerCase();

  // 1. Fetch robots.txt and sitemap.xml concurrently
  const [robots, sitemap] = await Promise.all([
    fetchAndParseRobotsTxt(startUrl),
    fetchAndParseSitemap(startUrl),
  ]);

  // Queue & visited state
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const visited = new Set<string>();
  const pages: CrawledPageResult[] = [];
  const statusCodesCount: Record<string, number> = {};
  let totalBytesDownloaded = 0;

  // Add sitemap URLs to crawl queue if within same hostname
  for (const sitemapPageUrl of sitemap.urls) {
    try {
      const u = new URL(sitemapPageUrl);
      if (u.hostname.toLowerCase() === hostname && queue.length < maxPages) {
        queue.push({ url: sitemapPageUrl, depth: 1 });
      }
    } catch {
      // Invalid URL ignored
    }
  }

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift()!;
    if (visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);

    const path = new URL(current.url).pathname;
    const isDisallowed = isPathDisallowedByRobots(path, robots.disallowedPaths, robots.allowedPaths);

    if (isDisallowed) {
      pages.push({
        url: current.url,
        normalizedUrl: current.url,
        statusCode: 403,
        responseTimeMs: 0,
        contentType: "",
        pageSizeBytes: 0,
        error: "Blocked by robots.txt Disallow directive.",
        hasRobotsTxtDisallow: true,
      });
      statusCodesCount["403"] = (statusCodesCount["403"] || 0) + 1;
      continue;
    }

    const fetchRes: FetchResult = await fetchUrl(current.url, { timeoutMs: options.timeoutMs || 8000 });
    totalBytesDownloaded += fetchRes.pageSizeBytes;

    const codeKey = fetchRes.statusCode.toString();
    statusCodesCount[codeKey] = (statusCodesCount[codeKey] || 0) + 1;

    let parsedData: ParsedPageData | undefined = undefined;
    if (fetchRes.statusCode === 200 && fetchRes.body && fetchRes.contentType.includes("html")) {
      parsedData = parsePageHtml(fetchRes.body, fetchRes.finalUrl);

      // Enqueue discovered internal links if under limits
      if (current.depth + 1 <= maxDepth) {
        for (const internalLink of parsedData.internalLinks) {
          if (!visited.has(internalLink) && pages.length + queue.length < maxPages * 2) {
            queue.push({ url: internalLink, depth: current.depth + 1 });
          }
        }
      }
    }

    pages.push({
      url: current.url,
      normalizedUrl: fetchRes.finalUrl,
      statusCode: fetchRes.statusCode,
      responseTimeMs: fetchRes.responseTimeMs,
      contentType: fetchRes.contentType,
      pageSizeBytes: fetchRes.pageSizeBytes,
      error: fetchRes.error,
      parsedData,
      hasRobotsTxtDisallow: false,
    });
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
  };
}
