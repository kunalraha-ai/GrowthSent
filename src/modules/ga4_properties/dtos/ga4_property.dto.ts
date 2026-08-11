import { IGa4Property, Ga4PropertyState } from "../interfaces/ga4_property.interface";

export interface Ga4PropertyResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
  propertyId: string;
  measurementId?: string;
  lastSyncedAt?: Date | null;
  state: Ga4PropertyState;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toGa4PropertyResponseDTO(property: IGa4Property, domainPublicId: string, projectPublicId: string): Ga4PropertyResponseDTO {
  return {
    publicId: property.publicId,
    domainPublicId,
    projectPublicId,
    propertyId: property.propertyId,
    measurementId: property.measurementId,
    lastSyncedAt: property.lastSyncedAt,
    state: property.state,
    schemaVersion: property.schemaVersion,
    createdAt: property.createdAt,
    updatedAt: property.updatedAt,
  };
}
