import { Schema, model } from "mongoose";
import { IPageDocument } from "../interfaces/page.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const pageSchema = new Schema<IPageDocument>(
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
    url: {
      type: String,
      required: true,
      trim: true,
    },
    urlHash: {
      type: String,
      required: true,
      index: true,
    },
    contentHash: {
      type: String,
      index: true,
    },
    titleHash: {
      type: String,
      index: true,
    },
    path: {
      type: String,
      required: true,
      trim: true,
    },
    statusCode: {
      type: Number,
      required: true,
      default: 200,
    },
    title: {
      type: String,
      trim: true,
    },
    metaDescription: {
      type: String,
      trim: true,
    },
    canonicalUrl: {
      type: String,
      trim: true,
    },
    isIndexable: {
      type: Boolean,
      default: true,
      required: true,
    },
    wordCount: {
      type: Number,
      default: 0,
      required: true,
    },
    loadTimeMs: {
      type: Number,
      default: 0,
      required: true,
    },
    discoverySource: {
      type: String,
      enum: ["sitemap", "crawl", "gsc", "manual", "backlink"],
      default: "crawl",
      required: true,
    },
    crawlSourceId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlSource",
      default: null,
    },
    lastCrawlJobId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlJob",
      default: null,
    },
    lastCrawledAt: {
      type: Date,
    },
    state: {
      type: String,
      enum: ["active", "archived", "deleted"],
      default: "active",
      required: true,
    },
    revision: {
      type: Number,
      default: 1,
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
    timestamps: true,
  }
);

// Indexes matching exact specification
pageSchema.index({ domainId: 1, urlHash: 1 }, { unique: true });
pageSchema.index({ domainId: 1, contentHash: 1 });
pageSchema.index({ domainId: 1, titleHash: 1 });
pageSchema.index({ domainId: 1, statusCode: 1, state: 1 });
pageSchema.index({ domainId: 1, discoverySource: 1 });
pageSchema.index({ projectId: 1, state: 1, lastCrawledAt: -1 });

// Pre-validate hook to assign publicId before validation
pageSchema.pre("validate", function (this: IPageDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_pag_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
pageSchema.pre("save", function (this: IPageDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const PageModel = model<IPageDocument>("Page", pageSchema);
