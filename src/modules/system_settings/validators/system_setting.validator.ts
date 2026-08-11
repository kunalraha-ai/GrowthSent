import { z } from "zod";

export const upsertSystemSettingSchema = z.object({
  key: z.string().min(1, "key is required").trim(),
  value: z.unknown(),
  description: z.string().optional(),
  updatedByUserPublicId: z.string().optional(),
});

export const querySystemSettingSchema = z.object({
  key: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type UpsertSystemSettingDTO = z.infer<typeof upsertSystemSettingSchema>;
export type QuerySystemSettingDTO = z.infer<typeof querySystemSettingSchema>;
