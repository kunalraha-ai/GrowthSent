import { KeywordModel } from "../models/keyword.model";
import { IKeyword, IKeywordDocument } from "../interfaces/keyword.interface";
import { UpdateQuery, Types } from "mongoose";

import { SearchEngineType, DeviceType } from "../interfaces/keyword.interface";

export class KeywordRepository {
  async create(keywordData: Partial<IKeyword>): Promise<IKeywordDocument> {
    const keyword = new KeywordModel(keywordData);
    return await keyword.save();
  }

  async findByPublicId(publicId: string): Promise<IKeywordDocument | null> {
    return await KeywordModel.findOne({ publicId, state: { $ne: "deleted" as const } })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByDomainTermEngine(
    domainId: Types.ObjectId,
    term: string,
    searchEngine: SearchEngineType,
    country: string,
    device: DeviceType
  ): Promise<IKeywordDocument | null> {
    return await KeywordModel.findOne({
      domainId,
      term: term.toLowerCase().trim(),
      searchEngine,
      country: country.toLowerCase().trim(),
      device,
      state: { $ne: "deleted" as const },
    })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ keywords: IKeywordDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [keywords, total] = await Promise.all([
      KeywordModel.find(queryFilter)
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      KeywordModel.countDocuments(queryFilter).exec(),
    ]);

    return { keywords, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IKeywordDocument>): Promise<IKeywordDocument | null> {
    const keyword = await KeywordModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!keyword) return null;

    Object.assign(keyword, updateData);
    const updated = await keyword.save();
    return await updated.populate([
      { path: "domainId", select: "publicId" },
      { path: "projectId", select: "publicId" },
    ]);
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const keyword = await KeywordModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!keyword) return false;

    keyword.state = "deleted";
    keyword.deletedAt = new Date();
    await keyword.save();
    return true;
  }
}
