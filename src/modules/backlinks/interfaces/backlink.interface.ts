import { Document, Types } from "mongoose";

export type LinkLocationType = "content" | "header" | "footer" | "sidebar" | "navigation" | "unknown";
export type DiscoveredByType = "Common Crawl" | "Ahrefs" | "Semrush" | "Native Crawler" | "Manual Import";
export type BacklinkState = "active" | "lost" | "deleted";

export interface IBacklink {
  _id: Types.ObjectId;
  publicId: string;
  targetDomainId: Types.ObjectId;
  targetUrl: string;
  targetUrlHash: string;
  sourceDomain: string;
  sourceUrl: string;
  sourceUrlHash: string;
  anchorText?: string;
  linkLocation: LinkLocationType;
  isNoFollow: boolean;
  isUgc: boolean;
  isSponsored: boolean;
  isLost: boolean;
  snapshot: string;
  discoveredBy: DiscoveredByType;
  crawlSourceId?: Types.ObjectId | null;
  domainAuthority: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  state: BacklinkState;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
}

export interface IBacklinkDocument extends IBacklink, Document<Types.ObjectId> {}
