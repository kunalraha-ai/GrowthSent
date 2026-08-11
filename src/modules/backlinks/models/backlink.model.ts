import { Schema, model } from "mongoose";
import { IBacklinkDocument } from "../interfaces/backlink.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const backlinkSchema = new Schema<IBacklinkDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    targetDomainId: {
      type: Schema.Types.ObjectId,
      ref: "Domain",
      required: true,
      index: true,
    },
    targetUrl: {
      type: String,
      required: true,
      trim: true,
    },
    targetUrlHash: {
      type: String,
      required: true,
    },
    sourceDomain: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    sourceUrl: {
      type: String,
      required: true,
      trim: true,
    },
    sourceUrlHash: {
      type: String,
      required: true,
    },
    anchorText: {
      type: String,
      trim: true,
    },
    linkLocation: {
      type: String,
      enum: ["content", "header", "footer", "sidebar", "navigation", "unknown"],
      default: "content",
      required: true,
    },
    isNoFollow: {
      type: Boolean,
      default: false,
      required: true,
    },
    isUgc: {
      type: Boolean,
      default: false,
      required: true,
    },
    isSponsored: {
      type: Boolean,
      default: false,
      required: true,
    },
    isLost: {
      type: Boolean,
      default: false,
      required: true,
    },
    snapshot: {
      type: String,
      required: true,
      trim: true,
    },
    discoveredBy: {
      type: String,
      enum: ["Common Crawl", "Ahrefs", "Semrush", "Native Crawler", "Manual Import"],
      default: "Native Crawler",
      required: true,
    },
    crawlSourceId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlSource",
      default: null,
    },
    domainAuthority: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      required: true,
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    state: {
      type: String,
      enum: ["active", "lost", "deleted"],
      default: "active",
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
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
backlinkSchema.index({ targetDomainId: 1, sourceUrlHash: 1, targetUrlHash: 1, snapshot: 1 }, { unique: true });
backlinkSchema.index({ targetDomainId: 1, snapshot: 1, isLost: 1, state: 1 });
backlinkSchema.index({ targetDomainId: 1, linkLocation: 1 });
backlinkSchema.index({ sourceDomain: 1 });

// Pre-validate hook to assign publicId before validation
backlinkSchema.pre("validate", function (this: IBacklinkDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_blk_");
  }
});

export const BacklinkModel = model<IBacklinkDocument>("Backlink", backlinkSchema);
