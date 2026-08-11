import { Document, Types } from "mongoose";

export interface ISystemSetting {
  _id: Types.ObjectId;
  publicId: string;
  key: string;
  value: unknown;
  description?: string;
  revision: number;
  updatedByUserId?: Types.ObjectId | null;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISystemSettingDocument extends ISystemSetting, Document<Types.ObjectId> {}
