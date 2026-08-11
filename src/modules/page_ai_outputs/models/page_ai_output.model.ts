import { Schema, model } from "mongoose";
import { IPageAiOutputDocument } from "../interfaces/page_ai_output.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const pageAiOutputSchema = new Schema<IPageAiOutputDocument>(
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
    promptHash: {
      type: String,
      required: true,
    },
    llmModel: {
      type: String,
      default: "gemini-2.5-flash",
      required: true,
      trim: true,
    },
    suggestedMetaTitle: {
      type: String,
      trim: true,
    },
    suggestedMetaDescription: {
      type: String,
      trim: true,
    },
    suggestedH1: {
      type: String,
      trim: true,
    },
    contentSummary: {
      type: String,
      trim: true,
    },
    actionableRecommendations: {
      type: [String],
      default: [],
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
pageAiOutputSchema.index({ pageId: 1, promptHash: 1 }, { unique: true });
pageAiOutputSchema.index({ domainId: 1, createdAt: -1 });

// Pre-validate hook to assign publicId before validation
pageAiOutputSchema.pre("validate", function (this: IPageAiOutputDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_aio_");
  }
});

export const PageAiOutputModel = model<IPageAiOutputDocument>("PageAiOutput", pageAiOutputSchema);
