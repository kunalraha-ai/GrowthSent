import { z } from "zod";
import { createHash } from "crypto";

export function computePromptHash(prompt: string): string {
  return createHash("sha256").update(prompt.trim()).digest("hex");
}

export const createPageAiOutputSchema = z.object({
  pagePublicId: z.string().min(1, "pagePublicId is required"),
  prompt: z.string().min(1, "Prompt is required"),
  llmModel: z.string().default("gemini-2.5-flash"),
  suggestedMetaTitle: z.string().optional(),
  suggestedMetaDescription: z.string().optional(),
  suggestedH1: z.string().optional(),
  contentSummary: z.string().optional(),
  actionableRecommendations: z.array(z.string()).default([]),
});

export const queryPageAiOutputSchema = z.object({
  pagePublicId: z.string().optional(),
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  llmModel: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreatePageAiOutputDTO = z.infer<typeof createPageAiOutputSchema>;
export type QueryPageAiOutputDTO = z.infer<typeof queryPageAiOutputSchema>;
