import { Schema, model } from "mongoose";
import { IPageAuditDocument } from "../interfaces/page_audit.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const engineMetadataSchema = new Schema(
  {
    engine: { type: String, default: "GrowthSent Core Auditor", required: true },
    ruleset: { type: String, default: "technical_v3", required: true },
    model: { type: String },
    configurationHash: { type: String },
  },
  { _id: false }
);

const issuesSummarySchema = new Schema(
  {
    critical: { type: Number, default: 0 },
    warning: { type: Number, default: 0 },
    info: { type: Number, default: 0 },
  },
  { _id: false }
);

const pageAuditSchema = new Schema<IPageAuditDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    pageId: {
      type: Schema.Types.ObjectId,
      ref: "Page",
      required: true,
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
      index: true,
    },
    snapshot: {
      type: String,
      required: true,
      trim: true,
    },
    auditDate: {
      type: String,
      required: true,
      trim: true,
    },
    algorithmVersion: {
      type: String,
      default: "1.0.0",
      required: true,
    },
    engineMetadata: {
      type: engineMetadataSchema,
      default: () => ({ engine: "GrowthSent Core Auditor", ruleset: "technical_v3" }),
    },
    seoScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
      required: true,
    },
    issuesSummary: {
      type: issuesSummarySchema,
      default: () => ({ critical: 0, warning: 0, info: 0 }),
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
pageAuditSchema.index({ pageId: 1, crawlJobId: 1, algorithmVersion: 1 }, { unique: true });
pageAuditSchema.index({ domainId: 1, auditDate: -1, algorithmVersion: 1 });
pageAuditSchema.index({ domainId: 1, seoScore: 1 });

// Pre-validate hook to assign publicId before validation
pageAuditSchema.pre("validate", function (this: IPageAuditDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_aud_");
  }
});

export const PageAuditModel = model<IPageAuditDocument>("PageAudit", pageAuditSchema);
