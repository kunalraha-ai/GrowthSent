import { Document, Types } from "mongoose";

export interface IEngineMetadata {
  engine: string;
  ruleset: string;
  model?: string;
  configurationHash?: string;
}

export interface IPageAuditIssuesSummary {
  critical: number;
  warning: number;
  info: number;
}

export interface IPageAudit {
  _id: Types.ObjectId;
  publicId: string;
  pageId: Types.ObjectId;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  crawlJobId: Types.ObjectId;
  snapshot: string;
  auditDate: string;
  algorithmVersion: string;
  engineMetadata: IEngineMetadata;
  seoScore: number;
  issuesSummary: IPageAuditIssuesSummary;
  schemaVersion: string;
  createdAt: Date;
}

export interface IPageAuditDocument extends IPageAudit, Document<Types.ObjectId> {}
