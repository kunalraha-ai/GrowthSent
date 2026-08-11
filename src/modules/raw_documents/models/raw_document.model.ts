import { Schema, model } from "mongoose";
import { IRawDocumentDocument } from "../interfaces/raw_document.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const rawDocumentStorageSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["s3", "r2", "gcs", "local"],
      default: "s3",
      required: true,
    },
    bucket: {
      type: String,
      required: true,
      trim: true,
    },
    objectKey: {
      type: String,
      required: true,
      trim: true,
    },
    checksum: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    byteSize: {
      type: Number,
      required: true,
      min: 0,
    },
    compression: {
      type: String,
      enum: ["gzip", "zstd", "none"],
      default: "gzip",
      required: true,
    },
    encoding: {
      type: String,
      default: "utf-8",
      required: true,
    },
    mimeType: {
      type: String,
      enum: ["application/warc", "text/html"],
      default: "application/warc",
      required: true,
    },
  },
  { _id: false }
);

const rawDocumentSchema = new Schema<IRawDocumentDocument>(
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
    pageId: {
      type: Schema.Types.ObjectId,
      ref: "Page",
      default: null,
    },
    crawlSourceId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlSource",
      required: true,
      index: true,
    },
    storage: {
      type: rawDocumentStorageSchema,
      required: true,
    },
    crawl: {
      type: String,
      required: true,
      trim: true,
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
rawDocumentSchema.index({ domainId: 1, crawl: 1 });

// Pre-validate hook to assign publicId before validation
rawDocumentSchema.pre("validate", function (this: IRawDocumentDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_doc_");
  }
});

export const RawDocumentModel = model<IRawDocumentDocument>("RawDocument", rawDocumentSchema);
