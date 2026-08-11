import { Collection, Document, Filter } from "mongodb";
import { connectToDataFederation } from "../db/data-federation.js";

const CRAWL = "CC-MAIN-2026-30";
const LINKS_COLLECTION = "links_prod_2026_30";
const QUERY_TIMEOUT_MS = 8_000;
const TOP_LIST_LIMIT = 25;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE = 100;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;
const UNIQUE_ANCHOR_CAP = 10_000;

export const BACKLINK_COVERAGE_LABEL = "Preview coverage: first 1,000 WAT files of CC-MAIN-2026-30, not a full-web backlink index.";

export interface BacklinkRow {
  sourceUrl: string;
  sourceHost: string | null;
  targetUrl: string;
  anchor: string | null;
  crawledAt: string | null;
}

export interface RankedValue {
  value: string;
  backlinkCount: number;
}

export interface LinkedPage extends RankedValue {
  referringDomainCount: number;
}

export interface BacklinkAnalyticsReport {
  domain: string;
  coverage: {
    crawl: string;
    label: string;
  };
  overview: {
    totalBacklinks: number;
    uniqueReferringDomains: number;
    uniqueLinkedPages: number;
    uniqueAnchors: number | null;
    uniqueAnchorsCapped: boolean;
  };
  backlinks: BacklinkRow[];
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
  };
  referringDomains: RankedValue[];
  topAnchors: RankedValue[];
  topLinkedPages: LinkedPage[];
}

export class BacklinkAnalyticsError extends Error {
  constructor(
    readonly code: "INVALID_DOMAIN" | "QUERY_TIMEOUT" | "DATA_FEDERATION_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "BacklinkAnalyticsError";
  }
}

export interface BacklinkAnalyticsCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
}

class InMemoryBacklinkAnalyticsCache implements BacklinkAnalyticsCache {
  private readonly entries = new Map<string, { expiresAt: number; value: unknown }>();

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

const cache: BacklinkAnalyticsCache = new InMemoryBacklinkAnalyticsCache();

interface LinkDocument extends Document {
  crawl?: string;
  source_url?: string;
  source_host?: string | null;
  target_url?: string;
  target_host?: string | null;
  anchor?: string | null;
  crawled_at?: Date | string | null;
}

interface AnalyticsOptions {
  page?: number;
  pageSize?: number;
}

export function normalizeBacklinkDomain(value: string): string {
  const input = value.trim().toLowerCase();
  if (!input || input.length > 253 || /\s/.test(input)) {
    throw new BacklinkAnalyticsError("INVALID_DOMAIN", "Enter a valid domain, such as github.com.");
  }

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new BacklinkAnalyticsError("INVALID_DOMAIN", "Enter a valid domain, such as github.com.");
  }

  // URL normalizes explicit default ports (for example :443) to an empty
  // `port`, so inspect the original authority as well.
  const authority = input.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split(/[/?#]/, 1)[0];
  const hasExplicitPort = /:\d+$/.test(authority);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port || hasExplicitPort) {
    throw new BacklinkAnalyticsError("INVALID_DOMAIN", "Enter a domain without credentials or a port.");
  }

  let hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !label || label.length > 63 || !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
  ) {
    throw new BacklinkAnalyticsError("INVALID_DOMAIN", "Enter a valid public domain, such as github.com.");
  }
  return hostname;
}

export function normalizeBacklinkPagination(options: AnalyticsOptions): { page: number; pageSize: number } {
  const page = Number.isInteger(options.page) ? Math.min(Math.max(options.page!, 1), MAX_PAGE) : 1;
  const pageSize = Number.isInteger(options.pageSize)
    ? Math.min(Math.max(options.pageSize!, 1), MAX_PAGE_SIZE)
    : 25;
  return { page, pageSize };
}

export function backlinkTargetFilter(domain: string): Filter<LinkDocument> {
  return {
    crawl: CRAWL,
    target_host: { $in: [domain, `www.${domain}`] },
  };
}

function valueFromId(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countFromValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function isTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === 50 || /time(?:d)? out|maxTimeMS|operation exceeded time limit/i.test(message);
}

async function aggregate(collection: Collection<LinkDocument>, pipeline: Document[]): Promise<Document[]> {
  try {
    return await collection.aggregate(pipeline, { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false, batchSize: TOP_LIST_LIMIT }).toArray();
  } catch (error) {
    if (isTimeout(error)) {
      throw new BacklinkAnalyticsError("QUERY_TIMEOUT", "This domain has too much preview data to summarize within the query limit. Try a more specific domain later.");
    }
    throw new BacklinkAnalyticsError("DATA_FEDERATION_UNAVAILABLE", "Backlink preview data is temporarily unavailable.");
  }
}

async function fetchBacklinkRows(
  collection: Collection<LinkDocument>,
  filter: Filter<LinkDocument>,
  page: number,
  pageSize: number
): Promise<BacklinkRow[]> {
  try {
    const documents = await collection
      .find(filter, {
        projection: { _id: 0, source_url: 1, source_host: 1, target_url: 1, anchor: 1, crawled_at: 1 },
        maxTimeMS: QUERY_TIMEOUT_MS,
      })
      .sort({ source_url: 1, target_url: 1, crawled_at: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();
    return documents.map((document) => ({
      sourceUrl: document.source_url || "",
      sourceHost: document.source_host || null,
      targetUrl: document.target_url || "",
      anchor: document.anchor || null,
      crawledAt: toIsoDate(document.crawled_at),
    }));
  } catch (error) {
    if (isTimeout(error)) {
      throw new BacklinkAnalyticsError("QUERY_TIMEOUT", "Backlink rows could not be loaded within the query limit. Try again shortly.");
    }
    throw new BacklinkAnalyticsError("DATA_FEDERATION_UNAVAILABLE", "Backlink preview data is temporarily unavailable.");
  }
}

async function getSummary(domain: string, filter: Filter<LinkDocument>) {
  const cacheKey = `summary:${domain}`;
  const cached = cache.get<Omit<BacklinkAnalyticsReport, "backlinks" | "pagination">>(cacheKey);
  if (cached) return cached;

  const { db } = await connectToDataFederation().catch((error: unknown) => {
    if (error instanceof BacklinkAnalyticsError) throw error;
    throw new BacklinkAnalyticsError("DATA_FEDERATION_UNAVAILABLE", "Backlink preview data is temporarily unavailable.");
  });
  const links = db.collection<LinkDocument>(LINKS_COLLECTION);
  const nonEmptyAnchorFilter: Filter<LinkDocument> = { ...filter, anchor: { $nin: [null, ""] } };

  const [totalRows, referringDomainCount, linkedPageCount, anchorCount, referringDomains, topAnchors, topLinkedPages] = await Promise.all([
    aggregate(links, [{ $match: filter }, { $count: "count" }]),
    aggregate(links, [
      { $match: filter },
      { $match: { source_host: { $nin: [null, ""] } } },
      { $group: { _id: "$source_host" } },
      { $count: "count" },
    ]),
    aggregate(links, [
      { $match: filter },
      { $match: { target_url: { $nin: [null, ""] } } },
      { $group: { _id: "$target_url" } },
      { $count: "count" },
    ]),
    aggregate(links, [
      { $match: nonEmptyAnchorFilter },
      { $group: { _id: "$anchor" } },
      { $limit: UNIQUE_ANCHOR_CAP + 1 },
      { $count: "count" },
    ]),
    aggregate(links, [
      { $match: filter },
      { $match: { source_host: { $nin: [null, ""] } } },
      { $group: { _id: "$source_host", backlinkCount: { $sum: 1 } } },
      { $sort: { backlinkCount: -1, _id: 1 } },
      { $limit: TOP_LIST_LIMIT },
    ]),
    aggregate(links, [
      { $match: nonEmptyAnchorFilter },
      { $group: { _id: "$anchor", backlinkCount: { $sum: 1 } } },
      { $sort: { backlinkCount: -1, _id: 1 } },
      { $limit: TOP_LIST_LIMIT },
    ]),
    aggregate(links, [
      { $match: filter },
      { $match: { target_url: { $nin: [null, ""] }, source_host: { $nin: [null, ""] } } },
      { $group: { _id: "$target_url", backlinkCount: { $sum: 1 }, referringDomains: { $addToSet: "$source_host" } } },
      { $project: { backlinkCount: 1, referringDomainCount: { $size: "$referringDomains" } } },
      { $sort: { backlinkCount: -1, _id: 1 } },
      { $limit: TOP_LIST_LIMIT },
    ]),
  ]);

  const uniqueAnchorCount = countFromValue(anchorCount[0]?.count);
  const summary = {
    domain,
    coverage: { crawl: CRAWL, label: BACKLINK_COVERAGE_LABEL },
    overview: {
      totalBacklinks: countFromValue(totalRows[0]?.count),
      uniqueReferringDomains: countFromValue(referringDomainCount[0]?.count),
      uniqueLinkedPages: countFromValue(linkedPageCount[0]?.count),
      uniqueAnchors: uniqueAnchorCount > UNIQUE_ANCHOR_CAP ? null : uniqueAnchorCount,
      uniqueAnchorsCapped: uniqueAnchorCount > UNIQUE_ANCHOR_CAP,
    },
    referringDomains: referringDomains.map((row) => ({ value: valueFromId(row._id), backlinkCount: countFromValue(row.backlinkCount) })),
    topAnchors: topAnchors.map((row) => ({ value: valueFromId(row._id), backlinkCount: countFromValue(row.backlinkCount) })),
    topLinkedPages: topLinkedPages.map((row) => ({
      value: valueFromId(row._id),
      backlinkCount: countFromValue(row.backlinkCount),
      referringDomainCount: countFromValue(row.referringDomainCount),
    })),
  };
  cache.set(cacheKey, summary, CACHE_TTL_MS);
  return summary;
}

export async function getBacklinkAnalytics(domainInput: string, options: AnalyticsOptions = {}): Promise<BacklinkAnalyticsReport> {
  const domain = normalizeBacklinkDomain(domainInput);
  const { page, pageSize } = normalizeBacklinkPagination(options);
  const filter = backlinkTargetFilter(domain);
  const [summary, { db }] = await Promise.all([
    getSummary(domain, filter),
    connectToDataFederation().catch(() => {
      throw new BacklinkAnalyticsError("DATA_FEDERATION_UNAVAILABLE", "Backlink preview data is temporarily unavailable.");
    }),
  ]);
  const rowCacheKey = `rows:${domain}:${page}:${pageSize}`;
  let backlinks = cache.get<BacklinkRow[]>(rowCacheKey);
  if (!backlinks) {
    backlinks = await fetchBacklinkRows(db.collection<LinkDocument>(LINKS_COLLECTION), filter, page, pageSize);
    cache.set(rowCacheKey, backlinks, CACHE_TTL_MS);
  }
  const totalPages = Math.max(1, Math.min(MAX_PAGE, Math.ceil(summary.overview.totalBacklinks / pageSize)) || 1);
  return {
    ...summary,
    backlinks,
    pagination: { page, pageSize, totalRows: summary.overview.totalBacklinks, totalPages },
  };
}
