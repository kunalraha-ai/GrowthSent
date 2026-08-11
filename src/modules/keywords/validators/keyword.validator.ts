import { z } from "zod";

export const createKeywordSchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  term: z.string().min(1, "Keyword term is required").transform((val) => val.toLowerCase().trim()),
  searchEngine: z.enum(["google", "bing", "brave", "duckduckgo"]).default("google"),
  country: z.string().length(2, "Country code must be 2 characters").default("us").transform((val) => val.toLowerCase()),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  searchVolume: z.number().int().min(0).default(0),
});

export const updateKeywordSchema = z.object({
  searchVolume: z.number().int().min(0).optional(),
  state: z.enum(["active", "paused", "deleted"]).optional(),
});

export const queryKeywordSchema = z.object({
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  searchEngine: z.enum(["google", "bing", "brave", "duckduckgo"]).optional(),
  country: z.string().optional(),
  device: z.enum(["desktop", "mobile"]).optional(),
  state: z.enum(["active", "paused", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateKeywordDTO = z.infer<typeof createKeywordSchema>;
export type UpdateKeywordDTO = z.infer<typeof updateKeywordSchema>;
export type QueryKeywordDTO = z.infer<typeof queryKeywordSchema>;
