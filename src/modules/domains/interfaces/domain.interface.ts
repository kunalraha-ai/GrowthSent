import { Document, Types } from "mongoose";

export type DomainState = "active" | "paused" | "archived" | "deleted";
export type VerificationMethodType = "dns" | "file" | "gsc" | "meta_tag";

export interface IDomainVerificationMethod {
  method: VerificationMethodType;
  isVerified: boolean;
  verifiedAt?: Date;
}

export interface IDomain {
  _id: Types.ObjectId;
  publicId: string;
  projectId: Types.ObjectId;
  hostname: string;
  apexDomain: string;
  scheme: "https" | "http";
  serverHeader?: string;
  verificationMethods: IDomainVerificationMethod[];
  lastCrawledAt?: Date;
  state: DomainState;
  revision: number;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDomainDocument extends IDomain, Document<Types.ObjectId> {}
