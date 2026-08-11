import { Document, Types } from "mongoose";

export type ApiKeyState = "active" | "revoked";

export interface IApiKey {
  _id: Types.ObjectId;
  publicId: string;
  userId: Types.ObjectId;
  name: string;
  keyPrefix: string;
  keyHash: string;
  permissions: string[];
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  state: ApiKeyState;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IApiKeyDocument extends IApiKey, Document<Types.ObjectId> {}
