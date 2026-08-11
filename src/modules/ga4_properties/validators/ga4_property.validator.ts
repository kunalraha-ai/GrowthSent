import { z } from "zod";

export const createGa4PropertySchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  propertyId: z.string().min(1, "propertyId is required").trim(),
  measurementId: z.string().optional(),
  encryptedCredentials: z.object({
    encryptedData: z.string().min(1),
    iv: z.string().min(1),
    authTag: z.string().min(1),
  }),
});

export const updateGa4PropertySchema = z.object({
  measurementId: z.string().optional(),
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

export const queryGa4PropertySchema = z.object({
  domainPublicId: z.string().optional(),
  projectPublicId: z.string().optional(),
  state: z.enum(["active", "error", "revoked"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateGa4PropertyDTO = z.infer<typeof createGa4PropertySchema>;
export type UpdateGa4PropertyDTO = z.infer<typeof updateGa4PropertySchema>;
export type QueryGa4PropertyDTO = z.infer<typeof queryGa4PropertySchema>;
