import { IPageMetadata, IOpenGraph, ITwitterCard, IHreflang } from "../interfaces/page_metadata.interface";

export interface PageMetadataResponseDTO {
  publicId: string;
  pagePublicId: string;
  domainPublicId: string;
  projectPublicId: string;
  openGraph?: IOpenGraph;
  twitterCard?: ITwitterCard;
  hreflang: IHreflang[];
  structuredDataTypes: string[];
  jsonLdPayloads: Record<string, unknown>[];
  robotsMeta?: string;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toPageMetadataResponseDTO(
  metadata: IPageMetadata,
  pagePublicId: string,
  domainPublicId: string,
  projectPublicId: string
): PageMetadataResponseDTO {
  return {
    publicId: metadata.publicId,
    pagePublicId,
    domainPublicId,
    projectPublicId,
    openGraph: metadata.openGraph,
    twitterCard: metadata.twitterCard,
    hreflang: metadata.hreflang || [],
    structuredDataTypes: metadata.structuredDataTypes || [],
    jsonLdPayloads: metadata.jsonLdPayloads || [],
    robotsMeta: metadata.robotsMeta,
    schemaVersion: metadata.schemaVersion,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}
