import { Document, Types } from "mongoose";

export interface IPageAiOutput {
  _id: Types.ObjectId;
  publicId: string;
  pageId: Types.ObjectId;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  promptHash: string;
  llmModel: string;
  suggestedMetaTitle?: string;
  suggestedMetaDescription?: string;
  suggestedH1?: string;
  contentSummary?: string;
  actionableRecommendations: string[];
  schemaVersion: string;
  createdAt: Date;
}

export interface IPageAiOutputDocument extends IPageAiOutput, Document<Types.ObjectId> {}
