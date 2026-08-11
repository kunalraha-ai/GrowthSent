import {
  IAuditIssue,
  AuditIssueSeverity,
  AuditIssueCategory,
  AuditIssueState,
  IAiSuggestedFix,
} from "../interfaces/audit_issue.interface";

export interface AuditIssueResponseDTO {
  publicId: string;
  auditPublicId: string;
  pagePublicId: string;
  domainPublicId: string;
  projectPublicId: string;
  ruleId: string;
  severity: AuditIssueSeverity;
  category: AuditIssueCategory;
  message: string;
  details?: Record<string, unknown>;
  state: AuditIssueState;
  assignedToUserPublicId?: string;
  aiSuggestedFix?: IAiSuggestedFix;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toAuditIssueResponseDTO(
  issue: IAuditIssue,
  auditPublicId: string,
  pagePublicId: string,
  domainPublicId: string,
  projectPublicId: string,
  assignedToUserPublicId?: string
): AuditIssueResponseDTO {
  return {
    publicId: issue.publicId,
    auditPublicId,
    pagePublicId,
    domainPublicId,
    projectPublicId,
    ruleId: issue.ruleId,
    severity: issue.severity,
    category: issue.category,
    message: issue.message,
    details: issue.details,
    state: issue.state,
    assignedToUserPublicId,
    aiSuggestedFix: issue.aiSuggestedFix,
    schemaVersion: issue.schemaVersion,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}
