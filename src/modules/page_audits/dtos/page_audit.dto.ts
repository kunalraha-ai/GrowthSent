import { IPageAudit, IEngineMetadata, IPageAuditIssuesSummary } from "../interfaces/page_audit.interface";

export interface PageAuditResponseDTO {
  publicId: string;
  pagePublicId: string;
  domainPublicId: string;
  projectPublicId: string;
  crawlJobPublicId: string;
  snapshot: string;
  auditDate: string;
  algorithmVersion: string;
  engineMetadata: IEngineMetadata;
  seoScore: number;
  issuesSummary: IPageAuditIssuesSummary;
  schemaVersion: string;
  createdAt: Date;
}

export function toPageAuditResponseDTO(
  audit: IPageAudit,
  pagePublicId: string,
  domainPublicId: string,
  projectPublicId: string,
  crawlJobPublicId: string
): PageAuditResponseDTO {
  return {
    publicId: audit.publicId,
    pagePublicId,
    domainPublicId,
    projectPublicId,
    crawlJobPublicId,
    snapshot: audit.snapshot,
    auditDate: audit.auditDate,
    algorithmVersion: audit.algorithmVersion,
    engineMetadata: audit.engineMetadata,
    seoScore: audit.seoScore,
    issuesSummary: audit.issuesSummary,
    schemaVersion: audit.schemaVersion,
    createdAt: audit.createdAt,
  };
}
