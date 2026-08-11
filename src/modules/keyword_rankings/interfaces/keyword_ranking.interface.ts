import { Document, Types } from "mongoose";
import { SearchEngineType } from "../../keywords/interfaces/keyword.interface";

export interface IKeywordRanking {
  _id: Types.ObjectId;
  publicId: string;
  keywordId: Types.ObjectId;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  rankingUrl: string;
  searchEngine: SearchEngineType;
  position: number;
  previousPosition?: number;
  snapshot: string;
  crawlJobId?: Types.ObjectId | null;
  schemaVersion: string;
  createdAt: Date;
}

export interface IKeywordRankingDocument extends IKeywordRanking, Document<Types.ObjectId> {}
