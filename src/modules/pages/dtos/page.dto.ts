import { IPage, PageState, DiscoverySourceType } from "../interfaces/page.interface";

export interface PageResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
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
  lastCrawledAt?: Date;
  state: PageState;
  revision: number;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toPageResponseDTO(page: IPage, domainPublicId: string, projectPublicId: string): PageResponseDTO {
  return {
    publicId: page.publicId,
    domainPublicId,
    projectPublicId,
    url: page.url,
    urlHash: page.urlHash,
    contentHash: page.contentHash,
    titleHash: page.titleHash,
    path: page.path,
    statusCode: page.statusCode,
    title: page.title,
    metaDescription: page.metaDescription,
    canonicalUrl: page.canonicalUrl,
    isIndexable: page.isIndexable,
    wordCount: page.wordCount,
    loadTimeMs: page.loadTimeMs,
    discoverySource: page.discoverySource,
    lastCrawledAt: page.lastCrawledAt,
    state: page.state,
    revision: page.revision,
    schemaVersion: page.schemaVersion,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}
