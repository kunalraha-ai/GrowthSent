import { Document, Types } from "mongoose";

export type StorageProviderType = "s3" | "r2" | "gcs" | "local";
export type CompressionType = "gzip" | "zstd" | "none";
export type MimeType = "application/warc" | "text/html";

export interface IRawDocumentStorage {
  provider: StorageProviderType;
  bucket: string;
  objectKey: string;
  checksum: string;
  byteSize: number;
  compression: CompressionType;
  encoding: string;
  mimeType: MimeType;
}

export interface IRawDocument {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  pageId?: Types.ObjectId | null;
  crawlSourceId: Types.ObjectId;
  storage: IRawDocumentStorage;
  crawl: string;
  schemaVersion: string;
  createdAt: Date;
}

export interface IRawDocumentDocument extends IRawDocument, Document<Types.ObjectId> {}
