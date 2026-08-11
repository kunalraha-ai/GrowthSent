import { Schema, model } from "mongoose";
import { ICrawlSourceDocument } from "../interfaces/crawl_source.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const crawlSourceSchema = new Schema<ICrawlSourceDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["dump", "api", "crawler", "user_import"],
      required: true,
    },
    provider: {
      type: String,
      enum: ["common_crawl", "google", "ahrefs", "semrush", "internal"],
      required: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
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
crawlSourceSchema.index({ provider: 1, type: 1 });
crawlSourceSchema.index({ isActive: 1 });

// Pre-validate hook to assign publicId before validation
crawlSourceSchema.pre("validate", function (this: ICrawlSourceDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_src_");
  }
});

export const CrawlSourceModel = model<ICrawlSourceDocument>("CrawlSource", crawlSourceSchema);
