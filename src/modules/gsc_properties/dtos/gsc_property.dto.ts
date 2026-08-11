import { IGscProperty, GscPermissionLevel, GscPropertyState } from "../interfaces/gsc_property.interface";

export interface GscPropertyResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
  siteUrl: string;
  permissionLevel: GscPermissionLevel;
  lastSyncedAt?: Date | null;
  state: GscPropertyState;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toGscPropertyResponseDTO(property: IGscProperty, domainPublicId: string, projectPublicId: string): GscPropertyResponseDTO {
  return {
    publicId: property.publicId,
    domainPublicId,
    projectPublicId,
    siteUrl: property.siteUrl,
    permissionLevel: property.permissionLevel,
    lastSyncedAt: property.lastSyncedAt,
    state: property.state,
    schemaVersion: property.schemaVersion,
    createdAt: property.createdAt,
    updatedAt: property.updatedAt,
  };
}
