import { z } from "zod";

export const createAuditIssueSchema = z.object({
  auditPublicId: z.string().min(1, "auditPublicId is required"),
  ruleId: z.string().min(1, "ruleId is required").trim(),
  severity: z.enum(["critical", "warning", "info"]).default("warning"),
  category: z.enum(["technical", "content", "mobile"]).default("technical"),
  message: z.string().min(1, "message is required").trim(),
  details: z.record(z.string(), z.unknown()).optional(),
  assignedToUserPublicId: z.string().optional(),
  aiSuggestedFix: z
    .object({
      explanation: z.string().optional(),
      codeDiff: z.string().optional(),
      targetFile: z.string().optional(),
    })
    .optional(),
});

export const updateAuditIssueSchema = z.object({
  state: z.enum(["open", "in_progress", "resolved", "suppressed"]).optional(),
  assignedToUserPublicId: z.string().nullable().optional(),
  aiSuggestedFix: z
    .object({
      explanation: z.string().optional(),
      codeDiff: z.string().optional(),
      targetFile: z.string().optional(),
    })
    .optional(),
});

export const queryAuditIssueSchema = z.object({
  auditPublicId: z.string().optional(),
  pagePublicId: z.string().optional(),
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  assignedToUserPublicId: z.string().optional(),
  severity: z.enum(["critical", "warning", "info"]).optional(),
  category: z.enum(["technical", "content", "mobile"]).optional(),
  state: z.enum(["open", "in_progress", "resolved", "suppressed"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateAuditIssueDTO = z.infer<typeof createAuditIssueSchema>;
export type UpdateAuditIssueDTO = z.infer<typeof updateAuditIssueSchema>;
export type QueryAuditIssueDTO = z.infer<typeof queryAuditIssueSchema>;
