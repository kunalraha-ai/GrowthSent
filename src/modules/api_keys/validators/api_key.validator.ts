import { z } from "zod";
import { createHash, randomBytes } from "crypto";

export function generateRawApiKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  const randomHex = randomBytes(24).toString("hex");
  const rawKey = `gs_live_${randomHex}`;
  const keyPrefix = rawKey.substring(0, 16);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  return { rawKey, keyPrefix, keyHash };
}

export function hashRawApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey.trim()).digest("hex");
}

export const createApiKeySchema = z.object({
  userPublicId: z.string().min(1, "userPublicId is required"),
  name: z.string().min(1, "API Key name is required").trim(),
  permissions: z.array(z.string()).default(["*"]),
  expiresAt: z.coerce.date().optional(),
});

export const updateApiKeySchema = z.object({
  name: z.string().min(1).trim().optional(),
  state: z.enum(["active", "revoked"]).optional(),
  permissions: z.array(z.string()).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

export const queryApiKeySchema = z.object({
  userPublicId: z.string().optional(),
  state: z.enum(["active", "revoked"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateApiKeyDTO = z.infer<typeof createApiKeySchema>;
export type UpdateApiKeyDTO = z.infer<typeof updateApiKeySchema>;
export type QueryApiKeyDTO = z.infer<typeof queryApiKeySchema>;
