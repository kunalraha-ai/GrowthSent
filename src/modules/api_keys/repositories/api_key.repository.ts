import { ApiKeyModel } from "../models/api_key.model";
import { IApiKey, IApiKeyDocument } from "../interfaces/api_key.interface";
import { UpdateQuery } from "mongoose";

export class ApiKeyRepository {
  async create(keyData: Partial<IApiKey>): Promise<IApiKeyDocument> {
    const key = new ApiKeyModel(keyData);
    return await key.save();
  }

  async findByPublicId(publicId: string): Promise<IApiKeyDocument | null> {
    return await ApiKeyModel.findOne({ publicId })
      .populate("userId", "publicId")
      .exec();
  }

  async findByKeyHash(keyHash: string): Promise<IApiKeyDocument | null> {
    return await ApiKeyModel.findOne({ keyHash, state: "active" })
      .populate("userId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ apiKeys: IApiKeyDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [apiKeys, total] = await Promise.all([
      ApiKeyModel.find(filter)
        .populate("userId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      ApiKeyModel.countDocuments(filter).exec(),
    ]);

    return { apiKeys, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IApiKeyDocument>): Promise<IApiKeyDocument | null> {
    const key = await ApiKeyModel.findOne({ publicId });
    if (!key) return null;

    Object.assign(key, updateData);
    const updated = await key.save();
    return await updated.populate({ path: "userId", select: "publicId" });
  }

  async touchLastUsed(publicId: string): Promise<void> {
    await ApiKeyModel.updateOne({ publicId }, { $set: { lastUsedAt: new Date() } }).exec();
  }
}
