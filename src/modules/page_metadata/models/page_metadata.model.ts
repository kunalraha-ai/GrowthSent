import { Schema, model } from "mongoose";
import { IPageMetadataDocument } from "../interfaces/page_metadata.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const openGraphSchema = new Schema(
  {
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    image: { type: String, trim: true },
    type: { type: String, trim: true },
  },
  { _id: false }
);

const twitterCardSchema = new Schema(
  {
    card: { type: String, trim: true },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    image: { type: String, trim: true },
  },
  { _id: false }
);

const hreflangSchema = new Schema(
  {
    lang: { type: String, required: true, trim: true },
    href: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const pageMetadataSchema = new Schema<IPageMetadataDocument>(
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
    openGraph: {
      type: openGraphSchema,
    },
    twitterCard: {
      type: twitterCardSchema,
    },
    hreflang: {
      type: [hreflangSchema],
      default: [],
    },
    structuredDataTypes: {
      type: [String],
      default: [],
    },
    jsonLdPayloads: {
      type: [Object],
      default: [],
    },
    robotsMeta: {
      type: String,
      trim: true,
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
pageMetadataSchema.index({ domainId: 1 });

// Pre-validate hook to assign publicId before validation
pageMetadataSchema.pre("validate", function (this: IPageMetadataDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_mtd_");
  }
});

export const PageMetadataModel = model<IPageMetadataDocument>("PageMetadata", pageMetadataSchema);
