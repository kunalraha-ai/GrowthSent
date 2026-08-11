import { z } from "zod";

export const createCrawlJobSchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  triggeredByUserPublicId: z.string().optional(),
  crawlSourcePublicId: z.string().optional(),
  engine: z.enum(["Internal", "CommonCrawl", "Athena", "DuckDB"]).default("Internal"),
  jobType: z.enum(["full_site_audit", "single_page_scan", "sitemap_refresh"]).default("full_site_audit"),
  configuration: z
    .object({
      maxDepth: z.number().int().min(1).max(50).optional(),
      maxPages: z.number().int().min(1).max(1000000).optional(),
      renderJavascript: z.boolean().optional(),
      respectRobots: z.boolean().optional(),
      userAgent: z.string().optional(),
      timeoutMs: z.number().int().min(1000).optional(),
    })
    .optional(),
});

export const updateCrawlJobSchema = z.object({
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]).optional(),
  worker: z
    .object({
      workerId: z.string().optional(),
      nodeId: z.string().optional(),
      region: z.string().optional(),
      queue: z.string().optional(),
      retryCount: z.number().int().optional(),
    })
    .optional(),
  stats: z
    .object({
      pagesDiscovered: z.number().int().min(0),
      pagesCrawled: z.number().int().min(0),
      pagesFailed: z.number().int().min(0),
      durationMs: z.number().int().min(0),
    })
    .optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  startedAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
});

export const queryCrawlJobSchema = z.object({
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]).optional(),
  engine: z.enum(["Internal", "CommonCrawl", "Athena", "DuckDB"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCrawlJobDTO = z.infer<typeof createCrawlJobSchema>;
export type UpdateCrawlJobDTO = z.infer<typeof updateCrawlJobSchema>;
export type QueryCrawlJobDTO = z.infer<typeof queryCrawlJobSchema>;
