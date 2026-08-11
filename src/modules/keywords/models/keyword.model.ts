import { Schema, model } from "mongoose";
import { IKeywordDocument } from "../interfaces/keyword.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const keywordSchema = new Schema<IKeywordDocument>(
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
    term: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    searchEngine: {
      type: String,
      enum: ["google", "bing", "brave", "duckduckgo"],
      default: "google",
      required: true,
    },
    country: {
      type: String,
      default: "us",
      lowercase: true,
      trim: true,
      required: true,
    },
    device: {
      type: String,
      enum: ["desktop", "mobile"],
      default: "desktop",
      required: true,
    },
    searchVolume: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    state: {
      type: String,
      enum: ["active", "paused", "deleted"],
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
keywordSchema.index({ domainId: 1, term: 1, searchEngine: 1, country: 1, device: 1 }, { unique: true });
keywordSchema.index({ projectId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
keywordSchema.pre("validate", function (this: IKeywordDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_kwd_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
keywordSchema.pre("save", function (this: IKeywordDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const KeywordModel = model<IKeywordDocument>("Keyword", keywordSchema);
