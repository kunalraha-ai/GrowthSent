import { ObjectId } from "mongodb";
import type { CommonCrawlMetrics, CommonCrawlPageProvenance, CrawlDataProviderName } from "../crawler/types.js";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type IssueCategory =
  | "technical"
  | "crawlability"
  | "indexability"
  | "metadata"
  | "content"
  | "links"
  | "structured-data"
  | "performance"
  | "security";

export type ScanStatus = "queued" | "crawling" | "analysing" | "completed" | "failed" | "cancelled";

export interface UserDocument {
  _id?: ObjectId;
  clerkUserId?: string;
  email: string;
  passwordHash?: string;
  name?: string;
  role: "user" | "admin";
  googleId?: string;
  githubId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDocument {
  _id?: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface WebsiteDocument {
  _id?: ObjectId;
  userId?: ObjectId;
  clerkUserId?: string;
  hostname: string;
  displayName: string;
  verifiedStatus: boolean;
  monitoringEnabled: boolean;
  monitoringFrequency: "daily" | "weekly";
  createdAt: Date;
  updatedAt: Date;
  lastScanAt?: Date;
  nextScanAt?: Date;
  /** Durable per-site audit lease used to serialize issue-lifecycle writes. */
  activeAuditLeaseId?: string;
  activeAuditLeaseExpiresAt?: Date;
}

export interface CrawlJobDocument {
  _id?: ObjectId;
  jobId: string;
  url: string;
  /** Server-selected and persisted at enqueue time; never accepted from the public API. */
  crawlProvider?: CrawlDataProviderName;
  /** Opaque HMAC admission identity for archive work; never returned publicly. */
  commonCrawlRequesterKey?: string;
  clerkUserId?: string;
  websiteId?: ObjectId;
  /** SHA-256 hash of the bearer capability for anonymous audit jobs. */
  accessTokenHash?: string;
  status: ScanStatus;
  progressPercent: number;
  pagesCrawled: number;
  error?: string;
  scanId?: ObjectId;
  /** Durable-worker lease fields. They are never trusted without an atomic claim. */
  leaseId?: string;
  leaseExpiresAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date;
  /** Redacted provider measurements retained for completed or failed attempts. */
  instrumentation?: {
    provider: CrawlDataProviderName;
    commonCrawl?: CommonCrawlMetrics;
    mongoPersistenceMs?: number;
    totalJobDurationMs?: number;
  };
  startedAt?: Date;
  createdAt: Date;
  completedAt?: Date;
}

export interface ScanDocument {
  _id?: ObjectId;
  websiteId?: ObjectId;
  /** Owner for authenticated scans that are not attached to a saved website. */
  ownerUserId?: ObjectId;
  clerkUserId?: string;
  anonymousSessionId?: string;
  /** SHA-256 hash of the bearer capability for anonymous scans. */
  anonymousAccessTokenHash?: string;
  /** Requested crawl bound, persisted so a worker need not trust a later request. */
  requestedMaxPages?: number;
  /** Durable-worker lease fields. */
  leaseId?: string;
  leaseExpiresAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date;
  /** Server-selected provider for a queued scan. Historical documents are live crawls. */
  crawlProvider?: CrawlDataProviderName;
  /** Opaque HMAC admission identity for archive work; never returned publicly. */
  commonCrawlRequesterKey?: string;
  url: string;
  hostname: string;
  startTime: Date;
  completionTime?: Date;
  status: ScanStatus;
  error?: string;
  crawlStats: {
    totalPagesCrawled: number;
    totalDurationMs: number;
    bytesDownloaded: number;
    statusCodesCount: Record<string, number>;
    provider?: CrawlDataProviderName;
    commonCrawl?: CommonCrawlMetrics;
    mongoPersistenceMs?: number;
    totalJobDurationMs?: number;
  };
  summaryMetrics: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    criticalIssues: number;
    highIssues: number;
    mediumIssues: number;
    lowIssues: number;
    infoIssues: number;
  };
  seoScore: number; // 0 to 100
  ruleVersion: string; // e.g. "1.0.0"
  scoreVersion: string;
  createdAt: Date;
}

export interface CrawlSnapshotDocument {
  _id?: ObjectId;
  websiteId: ObjectId;
  scanId: ObjectId;
  clerkUserId?: string;
  seoScore: number;
  ruleVersion: string;
  totalIssuesCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  totalPagesCount: number;
  snapshotDate: Date;
  createdAt: Date;
}

export interface PageDocument {
  _id?: ObjectId;
  scanId: ObjectId;
  websiteId?: ObjectId;
  url: string;
  normalizedUrl: string;
  statusCode: number;
  responseTimeMs: number;
  contentType?: string;
  pageSizeBytes: number;
  title?: string;
  metaDescription?: string;
  headings: {
    h1: string[];
    h2Count: number;
    h3Count: number;
  };
  canonicalUrl?: string;
  isNoindex: boolean;
  isNofollow: boolean;
  hasRobotsTxtDisallow: boolean;
  structuredDataTypes: string[]; // e.g. ['JSON-LD', 'Microdata']
  internalLinks: string[];
  externalLinks: string[];
  hreflangs: Record<string, string>;
  /** Archive provenance for Common Crawl-backed pages, when applicable. */
  provenance?: CommonCrawlPageProvenance;
  createdAt: Date;
}

export interface IssueDocument {
  _id?: ObjectId;
  scanId: ObjectId;
  websiteId?: ObjectId;
  ruleId: string;
  category: IssueCategory;
  severity: Severity;
  title: string;
  description: string;
  explanation: string;
  affectedUrl: string;
  evidence?: string;
  recommendation: string;
  createdAt: Date;
}

export interface SeoIssueHistoryDocument {
  _id?: ObjectId;
  websiteId: ObjectId;
  ruleId: string;
  affectedUrl: string;
  category: IssueCategory;
  severity: Severity;
  title: string;
  status: "active" | "resolved";
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  resolvedAt?: Date;
  reoccurredAt?: Date;
  historyEvents: Array<{
    event: "detected" | "resolved" | "reoccurred";
    timestamp: Date;
    scanId: ObjectId;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitoringSnapshotDocument {
  _id?: ObjectId;
  websiteId: ObjectId;
  scanId: ObjectId;
  newIssuesCount: number;
  resolvedIssuesCount: number;
  newPagesCount: number;
  removedPagesCount: number;
  summary: {
    newIssues: string[];
    resolvedIssues: string[];
    newPages: string[];
    removedPages: string[];
  };
  createdAt: Date;
}

export interface AnalyticsEventDocument {
  _id?: ObjectId;
  websiteId: ObjectId;
  anonymousVisitorId: string;
  sessionId: string;
  pageUrl: string;
  referrer?: string;
  viewportCategory?: "mobile" | "tablet" | "desktop";
  deviceCategory?: "mobile" | "tablet" | "desktop";
  browserCategory?: string;
  country?: string;
  timestamp: Date;
}

export interface AnalyticsAggregateDocument {
  _id?: ObjectId;
  websiteId: ObjectId;
  date: string; // YYYY-MM-DD
  totalPageviews: number;
  uniqueVisitors: number;
  uniqueSessions: number;
  topPages: Array<{ pageUrl: string; views: number }>;
  topReferrers: Array<{ referrer: string; count: number }>;
  deviceBreakdown: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationDocument {
  _id?: ObjectId;
  userId?: ObjectId;
  clerkUserId?: string;
  websiteId: ObjectId;
  provider: "google_search_console" | "google_analytics";
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  scopes: string[];
  status: "active" | "error" | "disconnected";
  accountEmail?: string;
  tokenExpiresAt?: Date;
  ga4PropertyId?: string;
  ga4PropertyDisplayName?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationDocument {
  _id?: ObjectId;
  userId?: ObjectId;
  clerkUserId?: string;
  websiteId?: ObjectId;
  type: "scan_completed" | "monitoring_alert" | "system";
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
}

export interface ApiKeyDocument {
  _id?: ObjectId;
  userId?: ObjectId;
  clerkUserId?: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  lastUsedAt?: Date;
  createdAt: Date;
}
