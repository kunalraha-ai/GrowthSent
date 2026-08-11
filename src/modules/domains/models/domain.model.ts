import { Schema, model } from "mongoose";
import { IDomainDocument } from "../interfaces/domain.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const verificationMethodSchema = new Schema(
  {
    method: {
      type: String,
      enum: ["dns", "file", "gsc", "meta_tag"],
      required: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: {
      type: Date,
    },
  },
  { _id: false }
);

const domainSchema = new Schema<IDomainDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    hostname: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    apexDomain: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    scheme: {
      type: String,
      enum: ["https", "http"],
      default: "https",
      required: true,
    },
    serverHeader: {
      type: String,
    },
    verificationMethods: {
      type: [verificationMethodSchema],
      default: [],
    },
    lastCrawledAt: {
      type: Date,
    },
    state: {
      type: String,
      enum: ["active", "paused", "archived", "deleted"],
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
domainSchema.index({ hostname: 1, projectId: 1 }, { unique: true });
domainSchema.index({ apexDomain: 1, state: 1 });
domainSchema.index({ projectId: 1, state: 1, lastCrawledAt: -1 });

// Pre-validate hook to assign publicId before validation
domainSchema.pre("validate", function (this: IDomainDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_dom_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
domainSchema.pre("save", function (this: IDomainDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const DomainModel = model<IDomainDocument>("Domain", domainSchema);
