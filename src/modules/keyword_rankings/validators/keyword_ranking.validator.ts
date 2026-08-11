import { z } from "zod";

export const createKeywordRankingSchema = z.object({
  keywordPublicId: z.string().min(1, "keywordPublicId is required"),
  rankingUrl: z.string().url("Invalid ranking URL").trim(),
  position: z.number().int().min(1, "Position must be >= 1"),
  previousPosition: z.number().int().min(1).optional(),
  snapshot: z.string().min(1, "snapshot is required").trim(),
  crawlJobPublicId: z.string().optional(),
});

export const queryKeywordRankingSchema = z.object({
  keywordPublicId: z.string().optional(),
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  searchEngine: z.enum(["google", "bing", "brave", "duckduckgo"]).optional(),
  snapshot: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateKeywordRankingDTO = z.infer<typeof createKeywordRankingSchema>;
export type QueryKeywordRankingDTO = z.infer<typeof queryKeywordRankingSchema>;
