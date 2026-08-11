import { z } from "zod";

export const createCrawlSourceSchema = z.object({
  name: z.string().min(1, "Name is required").trim(),
  type: z.enum(["dump", "api", "crawler", "user_import"]),
  provider: z.enum(["common_crawl", "google", "ahrefs", "semrush", "internal"]),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

export const updateCrawlSourceSchema = z.object({
  name: z.string().min(1).trim().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const queryCrawlSourceSchema = z.object({
  provider: z.enum(["common_crawl", "google", "ahrefs", "semrush", "internal"]).optional(),
  type: z.enum(["dump", "api", "crawler", "user_import"]).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCrawlSourceDTO = z.infer<typeof createCrawlSourceSchema>;
export type UpdateCrawlSourceDTO = z.infer<typeof updateCrawlSourceSchema>;
export type QueryCrawlSourceDTO = z.infer<typeof queryCrawlSourceSchema>;
