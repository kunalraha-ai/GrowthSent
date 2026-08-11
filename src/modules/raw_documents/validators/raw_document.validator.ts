import { z } from "zod";

export const createRawDocumentSchema = z.object({
  domainPublicId: z.string().min(1, "domainPublicId is required"),
  pagePublicId: z.string().optional(),
  crawlSourcePublicId: z.string().min(1, "crawlSourcePublicId is required"),
  storage: z.object({
    provider: z.enum(["s3", "r2", "gcs", "local"]).default("s3"),
    bucket: z.string().min(1, "bucket is required").trim(),
    objectKey: z.string().min(1, "objectKey is required").trim(),
    checksum: z.string().length(64, "checksum must be SHA-256 (64 chars)").trim(),
    byteSize: z.number().int().min(0),
    compression: z.enum(["gzip", "zstd", "none"]).default("gzip"),
    encoding: z.string().default("utf-8"),
    mimeType: z.enum(["application/warc", "text/html"]).default("application/warc"),
  }),
  crawl: z.string().min(1, "crawl release tag is required").trim(),
});

export const queryRawDocumentSchema = z.object({
  domainPublicId: z.string().optional(),
  pagePublicId: z.string().optional(),
  crawlSourcePublicId: z.string().optional(),
  crawl: z.string().optional(),
  checksum: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateRawDocumentDTO = z.infer<typeof createRawDocumentSchema>;
export type QueryRawDocumentDTO = z.infer<typeof queryRawDocumentSchema>;
