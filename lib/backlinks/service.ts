import { Collection, Document, Filter } from "mongodb";
import { connectToDataFederation } from "../db/data-federation.js";

const CRAWL = "CC-MAIN-2026-30";
const LINKS_COLLECTION = "links_prod_2026_30";
const QUERY_TIMEOUT_MS = 8_000;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE = 100;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

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
    totalBacklinks: number | null;
    uniqueReferringDomains: number | null;
    uniqueLinkedPages: number | null;
    uniqueAnchors: number | null;
    uniqueAnchorsCapped: boolean;
  };
  partial: boolean;
  unavailableSections: BacklinkAnalyticsSection[];
  backlinks: BacklinkRow[];
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number | null;
    totalPages: number | null;
  };
  referringDomains: RankedValue[];
  topAnchors: RankedValue[];
  topLinkedPages: LinkedPage[];
}

export type BacklinkAnalyticsSection =
  | "backlinks"
  | "totalBacklinks"
  | "uniqueReferringDomains"
  | "uniqueLinkedPages"
  | "uniqueAnchors"
  | "referringDomains"
  | "topAnchors"
  | "topLinkedPages";

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
  target_url?: string | null;
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
    // Keep this a single equality expression. Data Federation can use the
    // target_host Parquet row-group min/max metadata for this lookup, whereas
    // the former canonical-plus-www $in predicate fanned out across the
    // wildcard source.
    target_host: domain,
  };
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

async function fetchBacklinkRows(
  collection: Collection<LinkDocument>,
  filter: Filter<LinkDocument>,
  page: number,
  pageSize: number
): Promise<BacklinkRow[]> {
  const documents = await collection
    .find(filter, {
      projection: { _id: 0, source_url: 1, source_host: 1, target_url: 1, anchor: 1, crawled_at: 1 },
      maxTimeMS: QUERY_TIMEOUT_MS,
      timeoutMS: QUERY_TIMEOUT_MS,
      timeoutMode: "cursorLifetime",
    })
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
}

type BacklinkSummary = Omit<BacklinkAnalyticsReport, "backlinks" | "pagination">;

function unavailableSummary(domain: string): BacklinkSummary {
  // Data Federation plans the wildcard S3 mapping as a map-reduce source.
  // A limited find can stop after a small page of exact target_host matches,
  // but counts and grouped rankings must read every matching row group and
  // exceeded the fixed 8-second bound in production probes. Returning them
  // as unavailable is more accurate than delaying or failing the row lookup.
  return {
    domain,
    coverage: { crawl: CRAWL, label: BACKLINK_COVERAGE_LABEL },
    overview: {
      totalBacklinks: null,
      uniqueReferringDomains: null,
      uniqueLinkedPages: null,
      uniqueAnchors: null,
      uniqueAnchorsCapped: false,
    },
    partial: true,
    unavailableSections: [
      "totalBacklinks",
      "uniqueReferringDomains",
      "uniqueLinkedPages",
      "uniqueAnchors",
      "referringDomains",
      "topAnchors",
      "topLinkedPages",
    ],
    referringDomains: [],
    topAnchors: [],
    topLinkedPages: [],
  };
}

export async function getBacklinkAnalytics(domainInput: string, options: AnalyticsOptions = {}): Promise<BacklinkAnalyticsReport> {
  const domain = normalizeBacklinkDomain(domainInput);
  const { page, pageSize } = normalizeBacklinkPagination(options);
  const filter = backlinkTargetFilter(domain);
  const { db } = await connectToDataFederation().catch(() => {
    throw new BacklinkAnalyticsError("DATA_FEDERATION_UNAVAILABLE", "Backlink preview data is temporarily unavailable.");
  });
  const links = db.collection<LinkDocument>(LINKS_COLLECTION);
  const rowCacheKey = `rows:v2:${domain}:${page}:${pageSize}`;
  let backlinks = cache.get<BacklinkRow[]>(rowCacheKey);
  let backlinksAvailable = Boolean(backlinks);
  if (!backlinks) {
    try {
      backlinks = await fetchBacklinkRows(links, filter, page, pageSize);
      backlinksAvailable = true;
      cache.set(rowCacheKey, backlinks, CACHE_TTL_MS);
    } catch (error) {
      console.warn("[backlink-analytics] Bounded backlink row lookup did not complete.", {
        status: isTimeout(error) ? "timed_out" : "unavailable",
      });
      backlinks = [];
    }
  }
  const summary = unavailableSummary(domain);
  const unavailableSections: BacklinkAnalyticsSection[] = backlinksAvailable
    ? summary.unavailableSections
    : [...summary.unavailableSections, "backlinks"];
  return {
    ...summary,
    partial: unavailableSections.length > 0,
    unavailableSections,
    backlinks,
    pagination: { page, pageSize, totalRows: null, totalPages: null },
  };
}
