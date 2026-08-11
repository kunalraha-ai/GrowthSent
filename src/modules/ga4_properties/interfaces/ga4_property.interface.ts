import { Document, Types } from "mongoose";
import { IEncryptedCredentials } from "../../gsc_properties/interfaces/gsc_property.interface";

export type Ga4PropertyState = "active" | "error" | "revoked";

export interface IGa4Property {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  propertyId: string;
  measurementId?: string;
  encryptedCredentials: IEncryptedCredentials;
  lastSyncedAt?: Date | null;
  state: Ga4PropertyState;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IGa4PropertyDocument extends IGa4Property, Document<Types.ObjectId> {}
