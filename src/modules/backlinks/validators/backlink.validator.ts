import { z } from "zod";
import { createHash } from "crypto";

export function computeSha256(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex");
}

export function extractDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export const createBacklinkSchema = z.object({
  targetDomainPublicId: z.string().min(1, "targetDomainPublicId is required"),
  targetUrl: z.string().url("Invalid target URL").trim(),
  sourceUrl: z.string().url("Invalid source URL").trim(),
  anchorText: z.string().optional(),
  linkLocation: z.enum(["content", "header", "footer", "sidebar", "navigation", "unknown"]).default("content"),
  isNoFollow: z.boolean().default(false),
  isUgc: z.boolean().default(false),
  isSponsored: z.boolean().default(false),
  isLost: z.boolean().default(false),
  snapshot: z.string().min(1, "snapshot string is required").trim(),
  discoveredBy: z.enum(["Common Crawl", "Ahrefs", "Semrush", "Native Crawler", "Manual Import"]).default("Native Crawler"),
  crawlSourcePublicId: z.string().optional(),
  domainAuthority: z.number().min(0).max(100).default(0),
});

export const updateBacklinkSchema = z.object({
  isLost: z.boolean().optional(),
  domainAuthority: z.number().min(0).max(100).optional(),
  linkLocation: z.enum(["content", "header", "footer", "sidebar", "navigation", "unknown"]).optional(),
  state: z.enum(["active", "lost", "deleted"]).optional(),
});

export const queryBacklinkSchema = z.object({
  targetDomainPublicId: z.string().optional(),
  sourceDomain: z.string().optional(),
  snapshot: z.string().optional(),
  linkLocation: z.enum(["content", "header", "footer", "sidebar", "navigation", "unknown"]).optional(),
  isNoFollow: z.coerce.boolean().optional(),
  isLost: z.coerce.boolean().optional(),
  state: z.enum(["active", "lost", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateBacklinkDTO = z.infer<typeof createBacklinkSchema>;
export type UpdateBacklinkDTO = z.infer<typeof updateBacklinkSchema>;
export type QueryBacklinkDTO = z.infer<typeof queryBacklinkSchema>;
