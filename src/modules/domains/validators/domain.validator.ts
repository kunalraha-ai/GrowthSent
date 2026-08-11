import { z } from "zod";

function extractApexDomain(hostname: string): string {
  const parts = hostname.toLowerCase().trim().split(".");
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

export const createDomainSchema = z.object({
  projectPublicId: z.string().min(1, "projectPublicId is required"),
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .transform((val) => val.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim()),
  scheme: z.enum(["https", "http"]).default("https"),
  serverHeader: z.string().optional(),
});

export const updateDomainSchema = z.object({
  scheme: z.enum(["https", "http"]).optional(),
  serverHeader: z.string().optional(),
  state: z.enum(["active", "paused", "archived", "deleted"]).optional(),
  verificationMethods: z
    .array(
      z.object({
        method: z.enum(["dns", "file", "gsc", "meta_tag"]),
        isVerified: z.boolean(),
        verifiedAt: z.coerce.date().optional(),
      })
    )
    .optional(),
});

export const queryDomainSchema = z.object({
  projectPublicId: z.string().optional(),
  apexDomain: z.string().optional(),
  state: z.enum(["active", "paused", "archived", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateDomainDTO = z.infer<typeof createDomainSchema>;
export type UpdateDomainDTO = z.infer<typeof updateDomainSchema>;
export type QueryDomainDTO = z.infer<typeof queryDomainSchema>;
export { extractApexDomain };
