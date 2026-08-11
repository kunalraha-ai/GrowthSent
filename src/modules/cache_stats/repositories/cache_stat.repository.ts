import { CacheStatModel } from "../models/cache_stat.model";
import { ICacheStat, ICacheStatDocument } from "../interfaces/cache_stat.interface";
import { Types } from "mongoose";

export class CacheStatRepository {
  async upsertByDomainAndKey(
    domainId: Types.ObjectId,
    projectId: Types.ObjectId,
    key: string,
    payload: Record<string, unknown>,
    expiresAt: Date
  ): Promise<ICacheStatDocument> {
    const existing = await CacheStatModel.findOne({ domainId, key });
    if (existing) {
      existing.payload = payload;
      existing.expiresAt = expiresAt;
      return await existing.save();
    }
    const newStat = new CacheStatModel({
      domainId,
      projectId,
      key,
      payload,
      expiresAt,
      schemaVersion: "1.0.0",
    });
    return await newStat.save();
  }

  async findByDomainAndKey(domainId: Types.ObjectId, key: string): Promise<ICacheStatDocument | null> {
    return await CacheStatModel.findOne({ domainId, key, expiresAt: { $gt: new Date() } })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByPublicId(publicId: string): Promise<ICacheStatDocument | null> {
    return await CacheStatModel.findOne({ publicId, expiresAt: { $gt: new Date() } })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }
}
