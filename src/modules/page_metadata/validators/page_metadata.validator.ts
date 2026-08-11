import { z } from "zod";

export const upsertPageMetadataSchema = z.object({
  pagePublicId: z.string().min(1, "pagePublicId is required"),
  openGraph: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      image: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
  twitterCard: z
    .object({
      card: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      image: z.string().optional(),
    })
    .optional(),
  hreflang: z
    .array(
      z.object({
        lang: z.string().min(1),
        href: z.string().min(1),
      })
    )
    .optional(),
  structuredDataTypes: z.array(z.string()).optional(),
  jsonLdPayloads: z.array(z.record(z.string(), z.unknown())).optional(),
  robotsMeta: z.string().optional(),
});

export const queryPageMetadataSchema = z.object({
  pagePublicId: z.string().optional(),
  domainPublicId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type UpsertPageMetadataDTO = z.infer<typeof upsertPageMetadataSchema>;
export type QueryPageMetadataDTO = z.infer<typeof queryPageMetadataSchema>;
