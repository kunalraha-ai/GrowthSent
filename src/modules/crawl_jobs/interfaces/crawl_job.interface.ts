import { Document, Types } from "mongoose";

export type CrawlJobEngine = "Internal" | "CommonCrawl" | "Athena" | "DuckDB";
export type CrawlJobType = "full_site_audit" | "single_page_scan" | "sitemap_refresh";
export type CrawlJobStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

export interface ICrawlJobConfiguration {
  maxDepth?: number;
  maxPages?: number;
  renderJavascript?: boolean;
  respectRobots?: boolean;
  userAgent?: string;
  timeoutMs?: number;
}

export interface ICrawlJobWorker {
  workerId?: string;
  nodeId?: string;
  region?: string;
  queue?: string;
  retryCount?: number;
}

export interface ICrawlJobStats {
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesFailed: number;
  durationMs: number;
}

export interface ICrawlJobError {
  code?: string;
  message?: string;
}

export interface ICrawlJob {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  triggeredByUserId?: Types.ObjectId | null;
  crawlSourceId?: Types.ObjectId | null;
  engine: CrawlJobEngine;
  jobType: CrawlJobType;
  status: CrawlJobStatus;
  configuration: ICrawlJobConfiguration;
  worker?: ICrawlJobWorker;
  stats: ICrawlJobStats;
  error?: ICrawlJobError;
  startedAt?: Date;
  completedAt?: Date;
  schemaVersion: string;
  createdAt: Date;
}

export interface ICrawlJobDocument extends ICrawlJob, Document<Types.ObjectId> {}
