import { Document, Types } from "mongoose";

export interface ICacheStat {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  key: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICacheStatDocument extends ICacheStat, Document<Types.ObjectId> {}
