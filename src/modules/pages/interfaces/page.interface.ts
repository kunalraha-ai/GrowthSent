import { Document, Types } from "mongoose";

export type PageState = "active" | "archived" | "deleted";
export type DiscoverySourceType = "sitemap" | "crawl" | "gsc" | "manual" | "backlink";

export interface IPage {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  url: string;
  urlHash: string;
  contentHash?: string;
  titleHash?: string;
  path: string;
  statusCode: number;
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  isIndexable: boolean;
  wordCount: number;
  loadTimeMs: number;
  discoverySource: DiscoverySourceType;
  crawlSourceId?: Types.ObjectId | null;
  lastCrawlJobId?: Types.ObjectId | null;
  lastCrawledAt?: Date;
  state: PageState;
  revision: number;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPageDocument extends IPage, Document<Types.ObjectId> {}
