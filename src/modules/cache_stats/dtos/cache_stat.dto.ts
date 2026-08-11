import { ICacheStat } from "../interfaces/cache_stat.interface";

export interface CacheStatResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
  key: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toCacheStatResponseDTO(stat: ICacheStat, domainPublicId: string, projectPublicId: string): CacheStatResponseDTO {
  return {
    publicId: stat.publicId,
    domainPublicId,
    projectPublicId,
    key: stat.key,
    payload: stat.payload,
    expiresAt: stat.expiresAt,
    schemaVersion: stat.schemaVersion,
    createdAt: stat.createdAt,
    updatedAt: stat.updatedAt,
  };
}
