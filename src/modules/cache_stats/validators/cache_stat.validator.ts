import { z } from "zod";

export const upsertCacheStatSchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  key: z.string().min(1, "key is required").trim(),
  payload: z.record(z.string(), z.unknown()),
  ttlSeconds: z.number().int().min(1).default(86400), // Default 24 hours
});

export const queryCacheStatSchema = z.object({
  domainPublicId: z.string().optional(),
  key: z.string().optional(),
});

export type UpsertCacheStatDTO = z.infer<typeof upsertCacheStatSchema>;
export type QueryCacheStatDTO = z.infer<typeof queryCacheStatSchema>;
