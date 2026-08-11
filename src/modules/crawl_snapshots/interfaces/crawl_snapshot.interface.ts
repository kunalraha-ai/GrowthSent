import { Document, Types } from "mongoose";

export interface IIssuesBreakdown {
  critical: number;
  warning: number;
  info: number;
}

export interface ICrawlSnapshot {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  crawlJobId: Types.ObjectId;
  snapshot: string;
  resolvedIps: string[];
  pagesCount: number;
  backlinksCount: number;
  healthScore: number;
  issuesBreakdown: IIssuesBreakdown;
  durationMs: number;
  schemaVersion: string;
  createdAt: Date;
}

export interface ICrawlSnapshotDocument extends ICrawlSnapshot, Document<Types.ObjectId> {}
