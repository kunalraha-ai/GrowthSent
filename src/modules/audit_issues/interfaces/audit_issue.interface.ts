import { Document, Types } from "mongoose";

export type AuditIssueSeverity = "critical" | "warning" | "info";
export type AuditIssueCategory = "technical" | "content" | "mobile";
export type AuditIssueState = "open" | "in_progress" | "resolved" | "suppressed";

export interface IAiSuggestedFix {
  explanation?: string;
  codeDiff?: string;
  targetFile?: string;
}

export interface IAuditIssue {
  _id: Types.ObjectId;
  publicId: string;
  auditId: Types.ObjectId;
  pageId: Types.ObjectId;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  ruleId: string;
  severity: AuditIssueSeverity;
  category: AuditIssueCategory;
  message: string;
  details?: Record<string, unknown>;
  state: AuditIssueState;
  assignedToUserId?: Types.ObjectId | null;
  aiSuggestedFix?: IAiSuggestedFix;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAuditIssueDocument extends IAuditIssue, Document<Types.ObjectId> {}
