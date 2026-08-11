import { ICrawlSnapshot, IIssuesBreakdown } from "../interfaces/crawl_snapshot.interface";

export interface CrawlSnapshotResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
  crawlJobPublicId: string;
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

export function toCrawlSnapshotResponseDTO(
  snapshot: ICrawlSnapshot,
  domainPublicId: string,
  projectPublicId: string,
  crawlJobPublicId: string
): CrawlSnapshotResponseDTO {
  return {
    publicId: snapshot.publicId,
    domainPublicId,
    projectPublicId,
    crawlJobPublicId,
    snapshot: snapshot.snapshot,
    resolvedIps: snapshot.resolvedIps || [],
    pagesCount: snapshot.pagesCount,
    backlinksCount: snapshot.backlinksCount,
    healthScore: snapshot.healthScore,
    issuesBreakdown: snapshot.issuesBreakdown,
    durationMs: snapshot.durationMs,
    schemaVersion: snapshot.schemaVersion,
    createdAt: snapshot.createdAt,
  };
}
