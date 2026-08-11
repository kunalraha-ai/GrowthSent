import { Schema, model } from "mongoose";
import { ICrawlJobDocument } from "../interfaces/crawl_job.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const crawlJobConfigurationSchema = new Schema(
  {
    maxDepth: { type: Number, default: 5 },
    maxPages: { type: Number, default: 10000 },
    renderJavascript: { type: Boolean, default: false },
    respectRobots: { type: Boolean, default: true },
    userAgent: { type: String, default: "GrowthSentBot/1.0" },
    timeoutMs: { type: Number, default: 30000 },
  },
  { _id: false }
);

const crawlJobWorkerSchema = new Schema(
  {
    workerId: { type: String },
    nodeId: { type: String },
    region: { type: String },
    queue: { type: String },
    retryCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const crawlJobStatsSchema = new Schema(
  {
    pagesDiscovered: { type: Number, default: 0 },
    pagesCrawled: { type: Number, default: 0 },
    pagesFailed: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
  },
  { _id: false }
);

const crawlJobErrorSchema = new Schema(
  {
    code: { type: String },
    message: { type: String },
  },
  { _id: false }
);

const crawlJobSchema = new Schema<ICrawlJobDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    domainId: {
      type: Schema.Types.ObjectId,
      ref: "Domain",
      required: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    triggeredByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    crawlSourceId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlSource",
      default: null,
    },
    engine: {
      type: String,
      enum: ["Internal", "CommonCrawl", "Athena", "DuckDB"],
      default: "Internal",
      required: true,
    },
    jobType: {
      type: String,
      enum: ["full_site_audit", "single_page_scan", "sitemap_refresh"],
      default: "full_site_audit",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
      default: "pending",
      required: true,
      index: true,
    },
    configuration: {
      type: crawlJobConfigurationSchema,
      default: () => ({ maxDepth: 5, maxPages: 10000 }),
    },
    worker: {
      type: crawlJobWorkerSchema,
    },
    stats: {
      type: crawlJobStatsSchema,
      default: () => ({ pagesDiscovered: 0, pagesCrawled: 0, pagesFailed: 0, durationMs: 0 }),
    },
    error: {
      type: crawlJobErrorSchema,
    },
    startedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    schemaVersion: {
      type: String,
      default: "1.0.0",
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes matching exact specification
crawlJobSchema.index({ domainId: 1, createdAt: -1 });
crawlJobSchema.index({ projectId: 1, status: 1, createdAt: -1 });
crawlJobSchema.index({ status: 1, createdAt: 1 });
crawlJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days TTL

// Pre-validate hook to assign publicId before validation
crawlJobSchema.pre("validate", function (this: ICrawlJobDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_job_");
  }
});

export const CrawlJobModel = model<ICrawlJobDocument>("CrawlJob", crawlJobSchema);
