import { CrawlSourceModel } from "../models/crawl_source.model";
import { ICrawlSource, ICrawlSourceDocument } from "../interfaces/crawl_source.interface";
import { UpdateQuery } from "mongoose";

export class CrawlSourceRepository {
  async create(sourceData: Partial<ICrawlSource>): Promise<ICrawlSourceDocument> {
    const source = new CrawlSourceModel(sourceData);
    return await source.save();
  }

  async findByPublicId(publicId: string): Promise<ICrawlSourceDocument | null> {
    return await CrawlSourceModel.findOne({ publicId }).exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ sources: ICrawlSourceDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [sources, total] = await Promise.all([
      CrawlSourceModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      CrawlSourceModel.countDocuments(filter).exec(),
    ]);

    return { sources, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<ICrawlSourceDocument>): Promise<ICrawlSourceDocument | null> {
    const source = await CrawlSourceModel.findOne({ publicId });
    if (!source) return null;

    Object.assign(source, updateData);
    return await source.save();
  }
}
