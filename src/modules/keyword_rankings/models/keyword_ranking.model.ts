import { Schema, model } from "mongoose";
import { IKeywordRankingDocument } from "../interfaces/keyword_ranking.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const keywordRankingSchema = new Schema<IKeywordRankingDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    keywordId: {
      type: Schema.Types.ObjectId,
      ref: "Keyword",
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
    rankingUrl: {
      type: String,
      required: true,
      trim: true,
    },
    searchEngine: {
      type: String,
      enum: ["google", "bing", "brave", "duckduckgo"],
      default: "google",
      required: true,
    },
    position: {
      type: Number,
      required: true,
      min: 1,
    },
    previousPosition: {
      type: Number,
    },
    snapshot: {
      type: String,
      required: true,
      trim: true,
    },
    crawlJobId: {
      type: Schema.Types.ObjectId,
      ref: "CrawlJob",
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
keywordRankingSchema.index({ keywordId: 1, snapshot: 1 }, { unique: true });
keywordRankingSchema.index({ domainId: 1, searchEngine: 1, createdAt: -1 });
keywordRankingSchema.index({ keywordId: 1, createdAt: -1 });

// Pre-validate hook to assign publicId before validation
keywordRankingSchema.pre("validate", function (this: IKeywordRankingDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_rnk_");
  }
});

export const KeywordRankingModel = model<IKeywordRankingDocument>("KeywordRanking", keywordRankingSchema);
