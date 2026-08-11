import { Document, Types } from "mongoose";

export type GscPermissionLevel = "siteOwner" | "siteFullUser" | "siteRestrictedUser";
export type GscPropertyState = "active" | "error" | "revoked";

export interface IEncryptedCredentials {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export interface IGscProperty {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  siteUrl: string;
  permissionLevel: GscPermissionLevel;
  encryptedCredentials: IEncryptedCredentials;
  lastSyncedAt?: Date | null;
  state: GscPropertyState;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IGscPropertyDocument extends IGscProperty, Document<Types.ObjectId> {}
