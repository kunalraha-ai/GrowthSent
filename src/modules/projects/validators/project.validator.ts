import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1, "Project name is required").max(100, "Project name is too long").trim(),
  ownerPublicId: z.string().min(1, "Owner publicId is required"),
  settings: z
    .object({
      defaultScanFrequencyHours: z.number().int().min(1).max(168).optional(),
      alertWebhookUrl: z.string().url("Invalid alert webhook URL").optional().or(z.literal("")),
    })
    .optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  settings: z
    .object({
      defaultScanFrequencyHours: z.number().int().min(1).max(168).optional(),
      alertWebhookUrl: z.string().url("Invalid alert webhook URL").optional().or(z.literal("")),
    })
    .optional(),
  state: z.enum(["active", "archived", "deleted"]).optional(),
});

export const queryProjectSchema = z.object({
  ownerPublicId: z.string().optional(),
  state: z.enum(["active", "archived", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateProjectDTO = z.infer<typeof createProjectSchema>;
export type UpdateProjectDTO = z.infer<typeof updateProjectSchema>;
export type QueryProjectDTO = z.infer<typeof queryProjectSchema>;
