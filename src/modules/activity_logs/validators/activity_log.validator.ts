import { z } from "zod";

export const createActivityLogSchema = z.object({
  projectPublicId: z.string().min(1, "projectPublicId is required"),
  userPublicId: z.string().optional(),
  action: z.string().min(1, "action is required").trim(),
  targetEntity: z
    .object({
      entityType: z.string().min(1),
      entityId: z.string().min(1),
    })
    .optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const queryActivityLogSchema = z.object({
  projectPublicId: z.string().optional(),
  userPublicId: z.string().optional(),
  action: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateActivityLogDTO = z.infer<typeof createActivityLogSchema>;
export type QueryActivityLogDTO = z.infer<typeof queryActivityLogSchema>;
