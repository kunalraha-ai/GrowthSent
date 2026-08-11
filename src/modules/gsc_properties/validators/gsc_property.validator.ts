import { z } from "zod";

export const createGscPropertySchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  siteUrl: z.string().min(1, "siteUrl is required").trim(),
  permissionLevel: z.enum(["siteOwner", "siteFullUser", "siteRestrictedUser"]).default("siteOwner"),
  encryptedCredentials: z.object({
    encryptedData: z.string().min(1),
    iv: z.string().min(1),
    authTag: z.string().min(1),
  }),
});

export const updateGscPropertySchema = z.object({
  permissionLevel: z.enum(["siteOwner", "siteFullUser", "siteRestrictedUser"]).optional(),
  state: z.enum(["active", "error", "revoked"]).optional(),
  encryptedCredentials: z
    .object({
      encryptedData: z.string().min(1),
      iv: z.string().min(1),
      authTag: z.string().min(1),
    })
    .optional(),
  lastSyncedAt: z.coerce.date().optional(),
});

export const queryGscPropertySchema = z.object({
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  state: z.enum(["active", "error", "revoked"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateGscPropertyDTO = z.infer<typeof createGscPropertySchema>;
export type UpdateGscPropertyDTO = z.infer<typeof updateGscPropertySchema>;
export type QueryGscPropertyDTO = z.infer<typeof queryGscPropertySchema>;
