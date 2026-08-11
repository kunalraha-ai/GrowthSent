import { z } from "zod";

export const createCrawlSnapshotSchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  crawlJobPublicId: z.string().min(1, "crawlJobPublicId is required"),
  snapshot: z.string().min(1, "snapshot string is required").trim(),
  resolvedIps: z.array(z.string()).optional(),
  pagesCount: z.number().int().min(0).default(0),
  backlinksCount: z.number().int().min(0).default(0),
  healthScore: z.number().min(0).max(100).default(100),
  issuesBreakdown: z
    .object({
      critical: z.number().int().min(0).default(0),
      warning: z.number().int().min(0).default(0),
      info: z.number().int().min(0).default(0),
    })
    .optional(),
  durationMs: z.number().int().min(0).default(0),
});

export const queryCrawlSnapshotSchema = z.object({
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  snapshot: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCrawlSnapshotDTO = z.infer<typeof createCrawlSnapshotSchema>;
export type QueryCrawlSnapshotDTO = z.infer<typeof queryCrawlSnapshotSchema>;
