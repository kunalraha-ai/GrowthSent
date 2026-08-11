import { IRawDocument, IRawDocumentStorage } from "../interfaces/raw_document.interface";

export interface RawDocumentResponseDTO {
  publicId: string;
  domainPublicId: string;
  pagePublicId?: string;
  crawlSourcePublicId: string;
  storage: IRawDocumentStorage;
  crawl: string;
  schemaVersion: string;
  createdAt: Date;
}

export function toRawDocumentResponseDTO(
  doc: IRawDocument,
  domainPublicId: string,
  crawlSourcePublicId: string,
  pagePublicId?: string
): RawDocumentResponseDTO {
  return {
    publicId: doc.publicId,
    domainPublicId,
    pagePublicId,
    crawlSourcePublicId,
    storage: doc.storage,
    crawl: doc.crawl,
    schemaVersion: doc.schemaVersion,
    createdAt: doc.createdAt,
  };
}
