import { z } from "zod";

export const createPageAuditSchema = z.object({
  pagePublicId: z.string().min(1, "pagePublicId is required"),
  crawlJobPublicId: z.string().min(1, "crawlJobPublicId is required"),
  snapshot: z.string().min(1, "snapshot string is required").trim(),
  algorithmVersion: z.string().default("1.0.0"),
  engineMetadata: z
    .object({
      engine: z.string().default("GrowthSent Core Auditor"),
      ruleset: z.string().default("technical_v3"),
      model: z.string().optional(),
      configurationHash: z.string().optional(),
    })
    .optional(),
  seoScore: z.number().min(0).max(100).default(100),
  issuesSummary: z
    .object({
      critical: z.number().int().min(0).default(0),
      warning: z.number().int().min(0).default(0),
      info: z.number().int().min(0).default(0),
    })
    .optional(),
});

export const queryPageAuditSchema = z.object({
  pagePublicId: z.string().optional(),
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  crawlJobPublicId: z.string().optional(),
  algorithmVersion: z.string().optional(),
  auditDate: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreatePageAuditDTO = z.infer<typeof createPageAuditSchema>;
export type QueryPageAuditDTO = z.infer<typeof queryPageAuditSchema>;
