import { z } from "zod"

export function normalizeDomain(value: string): string {
  let cleaned = value.trim().toLowerCase()
  if (!cleaned.includes("://") && !cleaned.startsWith("//")) {
    cleaned = "https://" + cleaned
  }
  try {
    return new URL(cleaned).hostname
  } catch {
    return value.trim().toLowerCase()
  }
}

export const domainParamSchema = z.object({
  domain: z.string().min(1, "domain is required").transform(normalizeDomain),
})

export const referringDomainsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export const topPagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export const anchorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const brokenBacklinksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(["candidate", "verified_broken", "verified_live"]).optional(),
})

export const gapQuerySchema = z.object({
  competitor: z
    .string()
    .min(1, "competitor is required")
    .transform(normalizeDomain),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export type ReferringDomainsQueryDTO = z.infer<typeof referringDomainsQuerySchema>
export type TopPagesQueryDTO = z.infer<typeof topPagesQuerySchema>
export type AnchorsQueryDTO = z.infer<typeof anchorsQuerySchema>
export type BrokenBacklinksQueryDTO = z.infer<typeof brokenBacklinksQuerySchema>
export type GapQueryDTO = z.infer<typeof gapQuerySchema>
