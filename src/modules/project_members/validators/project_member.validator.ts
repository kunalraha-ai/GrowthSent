import { z } from "zod";

export const addProjectMemberSchema = z.object({
  projectPublicId: z.string().min(1, "projectPublicId is required"),
  userPublicId: z.string().min(1, "userPublicId is required"),
  role: z.enum(["owner", "admin", "editor", "viewer"]).default("viewer"),
  invitedByUserPublicId: z.string().min(1, "invitedByUserPublicId is required"),
});

export const updateProjectMemberSchema = z.object({
  role: z.enum(["owner", "admin", "editor", "viewer"]).optional(),
  state: z.enum(["active", "pending", "deleted"]).optional(),
});

export const queryProjectMemberSchema = z.object({
  projectPublicId: z.string().optional(),
  userPublicId: z.string().optional(),
  state: z.enum(["active", "pending", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AddProjectMemberDTO = z.infer<typeof addProjectMemberSchema>;
export type UpdateProjectMemberDTO = z.infer<typeof updateProjectMemberSchema>;
export type QueryProjectMemberDTO = z.infer<typeof queryProjectMemberSchema>;
