import { Document, Types } from "mongoose";

export interface ITargetEntity {
  entityType: string;
  entityId: string;
}

export interface IActivityLog {
  _id: Types.ObjectId;
  publicId: string;
  projectId: Types.ObjectId;
  userId?: Types.ObjectId | null;
  action: string;
  targetEntity?: ITargetEntity;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  schemaVersion: string;
  createdAt: Date;
}

export interface IActivityLogDocument extends IActivityLog, Document<Types.ObjectId> {}
