import { ICrawlSource, CrawlSourceType, CrawlSourceProvider } from "../interfaces/crawl_source.interface";

export interface CrawlSourceResponseDTO {
  publicId: string;
  name: string;
  type: CrawlSourceType;
  provider: CrawlSourceProvider;
  description?: string;
  isActive: boolean;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toCrawlSourceResponseDTO(source: ICrawlSource): CrawlSourceResponseDTO {
  return {
    publicId: source.publicId,
    name: source.name,
    type: source.type,
    provider: source.provider,
    description: source.description,
    isActive: source.isActive,
    schemaVersion: source.schemaVersion,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
