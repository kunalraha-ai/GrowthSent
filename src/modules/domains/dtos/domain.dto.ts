import { IDomain, DomainState, IDomainVerificationMethod } from "../interfaces/domain.interface";

export interface DomainResponseDTO {
  publicId: string;
  projectPublicId: string;
  hostname: string;
  apexDomain: string;
  scheme: "https" | "http";
  serverHeader?: string;
  verificationMethods: IDomainVerificationMethod[];
  lastCrawledAt?: Date;
  state: DomainState;
  revision: number;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toDomainResponseDTO(domain: IDomain, projectPublicId: string): DomainResponseDTO {
  return {
    publicId: domain.publicId,
    projectPublicId,
    hostname: domain.hostname,
    apexDomain: domain.apexDomain,
    scheme: domain.scheme,
    serverHeader: domain.serverHeader,
    verificationMethods: domain.verificationMethods || [],
    lastCrawledAt: domain.lastCrawledAt,
    state: domain.state,
    revision: domain.revision,
    schemaVersion: domain.schemaVersion,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}
