import { z } from "zod";
import { createHash } from "crypto";

export function computeSha256(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex");
}

export function extractPathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || "/";
  } catch {
    return "/";
  }
}

export const createPageSchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  url: z.string().url("Invalid page URL").trim(),
  contentHtml: z.string().optional(),
  title: z.string().optional(),
  metaDescription: z.string().optional(),
  canonicalUrl: z.string().url().optional().or(z.literal("")),
  statusCode: z.number().int().default(200),
  isIndexable: z.boolean().default(true),
  wordCount: z.number().int().min(0).default(0),
  loadTimeMs: z.number().int().min(0).default(0),
  discoverySource: z.enum(["sitemap", "crawl", "gsc", "manual", "backlink"]).default("crawl"),
  crawlSourcePublicId: z.string().optional(),
  lastCrawlJobPublicId: z.string().optional(),
});

export const updatePageSchema = z.object({
  title: z.string().optional(),
  metaDescription: z.string().optional(),
  canonicalUrl: z.string().url().optional().or(z.literal("")),
  statusCode: z.number().int().optional(),
  isIndexable: z.boolean().optional(),
  wordCount: z.number().int().min(0).optional(),
  loadTimeMs: z.number().int().min(0).optional(),
  state: z.enum(["active", "archived", "deleted"]).optional(),
});

export const queryPageSchema = z.object({
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  statusCode: z.coerce.number().int().optional(),
  isIndexable: z.coerce.boolean().optional(),
  discoverySource: z.enum(["sitemap", "crawl", "gsc", "manual", "backlink"]).optional(),
  state: z.enum(["active", "archived", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreatePageDTO = z.infer<typeof createPageSchema>;
export type UpdatePageDTO = z.infer<typeof updatePageSchema>;
export type QueryPageDTO = z.infer<typeof queryPageSchema>;
