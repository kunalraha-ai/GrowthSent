import { Document, Types } from "mongoose";

export type CrawlSourceType = "dump" | "api" | "crawler" | "user_import";
export type CrawlSourceProvider = "common_crawl" | "google" | "ahrefs" | "semrush" | "internal";

export interface ICrawlSource {
  _id: Types.ObjectId;
  publicId: string;
  name: string;
  type: CrawlSourceType;
  provider: CrawlSourceProvider;
  description?: string;
  isActive: boolean;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICrawlSourceDocument extends ICrawlSource, Document<Types.ObjectId> {}
