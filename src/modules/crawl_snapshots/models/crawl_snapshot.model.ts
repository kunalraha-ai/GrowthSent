import { Schema, model } from "mongoose";
import { ICrawlSnapshotDocument } from "../interfaces/crawl_snapshot.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const issuesBreakdownSchema = new Schema(
  {
    critical: { type: Number, default: 0 },
    warning: { type: Number, default: 0 },
    info: { type: Number, default: 0 },
  },
  { _id: false }
);

const crawlSnapshotSchema = new Schema<ICrawlSnapshotDocument>(
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
    crawlJobId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlJob",
      required: true,
    },
    snapshot: {
      type: String,
      required: true,
      trim: true,
    },
    resolvedIps: {
      type: [String],
      default: [],
    },
    pagesCount: {
      type: Number,
      default: 0,
      required: true,
    },
    backlinksCount: {
      type: Number,
      default: 0,
      required: true,
    },
    healthScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
      required: true,
    },
    issuesBreakdown: {
      type: issuesBreakdownSchema,
      default: () => ({ critical: 0, warning: 0, info: 0 }),
    },
    durationMs: {
      type: Number,
      default: 0,
      required: true,
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
crawlSnapshotSchema.index({ domainId: 1, snapshot: 1 }, { unique: true });
crawlSnapshotSchema.index({ domainId: 1, createdAt: -1 });

// Pre-validate hook to assign publicId before validation
crawlSnapshotSchema.pre("validate", function (this: ICrawlSnapshotDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_snp_");
  }
});

export const CrawlSnapshotModel = model<ICrawlSnapshotDocument>("CrawlSnapshot", crawlSnapshotSchema);
