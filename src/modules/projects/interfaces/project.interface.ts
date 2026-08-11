import { Document, Types } from "mongoose";

export type ProjectState = "active" | "archived" | "deleted";

export interface IProjectSettings {
  defaultScanFrequencyHours?: number;
  alertWebhookUrl?: string;
}

export interface IProject {
  _id: Types.ObjectId;
  publicId: string;
  name: string;
  ownerId: Types.ObjectId;
  settings: IProjectSettings;
  state: ProjectState;
  revision: number;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IProjectDocument extends IProject, Document<Types.ObjectId> {}
