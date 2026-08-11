import { IPageAiOutput } from "../interfaces/page_ai_output.interface";

export interface PageAiOutputResponseDTO {
  publicId: string;
  pagePublicId: string;
  domainPublicId: string;
  projectPublicId: string;
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

export function toPageAiOutputResponseDTO(
  aiOutput: IPageAiOutput,
  pagePublicId: string,
  domainPublicId: string,
  projectPublicId: string
): PageAiOutputResponseDTO {
  return {
    publicId: aiOutput.publicId,
    pagePublicId,
    domainPublicId,
    projectPublicId,
    promptHash: aiOutput.promptHash,
    llmModel: aiOutput.llmModel,
    suggestedMetaTitle: aiOutput.suggestedMetaTitle,
    suggestedMetaDescription: aiOutput.suggestedMetaDescription,
    suggestedH1: aiOutput.suggestedH1,
    contentSummary: aiOutput.contentSummary,
    actionableRecommendations: aiOutput.actionableRecommendations || [],
    schemaVersion: aiOutput.schemaVersion,
    createdAt: aiOutput.createdAt,
  };
}
