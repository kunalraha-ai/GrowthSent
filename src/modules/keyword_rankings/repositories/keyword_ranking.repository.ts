import { KeywordRankingModel } from "../models/keyword_ranking.model";
import { IKeywordRanking, IKeywordRankingDocument } from "../interfaces/keyword_ranking.interface";
import { Types } from "mongoose";

export class KeywordRankingRepository {
  async create(rankingData: Partial<IKeywordRanking>): Promise<IKeywordRankingDocument> {
    const ranking = new KeywordRankingModel(rankingData);
    return await ranking.save();
  }

  async findByPublicId(publicId: string): Promise<IKeywordRankingDocument | null> {
    return await KeywordRankingModel.findOne({ publicId })
      .populate("keywordId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("crawlJobId", "publicId")
      .exec();
  }

  async findByKeywordAndSnapshot(keywordId: Types.ObjectId, snapshot: string): Promise<IKeywordRankingDocument | null> {
    return await KeywordRankingModel.findOne({ keywordId, snapshot })
      .populate("keywordId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("crawlJobId", "publicId")
      .exec();
  }

  async findLatestByKeyword(keywordId: Types.ObjectId): Promise<IKeywordRankingDocument | null> {
    return await KeywordRankingModel.findOne({ keywordId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ rankings: IKeywordRankingDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [rankings, total] = await Promise.all([
      KeywordRankingModel.find(filter)
        .populate("keywordId", "publicId")
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .populate("crawlJobId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      KeywordRankingModel.countDocuments(filter).exec(),
    ]);

    return { rankings, total };
  }
}
