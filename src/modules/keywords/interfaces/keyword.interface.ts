import { Document, Types } from "mongoose";

export type SearchEngineType = "google" | "bing" | "brave" | "duckduckgo";
export type DeviceType = "desktop" | "mobile";
export type KeywordState = "active" | "paused" | "deleted";

export interface IKeyword {
  _id: Types.ObjectId;
  publicId: string;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  term: string;
  searchEngine: SearchEngineType;
  country: string;
  device: DeviceType;
  searchVolume: number;
  state: KeywordState;
  revision: number;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IKeywordDocument extends IKeyword, Document<Types.ObjectId> {}
