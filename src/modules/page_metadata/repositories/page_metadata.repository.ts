import { PageMetadataModel } from "../models/page_metadata.model";
import { IPageMetadata, IPageMetadataDocument } from "../interfaces/page_metadata.interface";
import { UpdateQuery, Types } from "mongoose";

export class PageMetadataRepository {
  async upsertByPageId(pageId: Types.ObjectId, metadataData: Partial<IPageMetadata>): Promise<IPageMetadataDocument> {
    const existing = await PageMetadataModel.findOne({ pageId });
    if (existing) {
      Object.assign(existing, metadataData);
      return await existing.save();
    }
    const newMetadata = new PageMetadataModel({ ...metadataData, pageId });
    return await newMetadata.save();
  }

  async findByPublicId(publicId: string): Promise<IPageMetadataDocument | null> {
    return await PageMetadataModel.findOne({ publicId })
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByPageId(pageId: Types.ObjectId): Promise<IPageMetadataDocument | null> {
    return await PageMetadataModel.findOne({ pageId })
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ metadataList: IPageMetadataDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [metadataList, total] = await Promise.all([
      PageMetadataModel.find(filter)
        .populate("pageId", "publicId")
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      PageMetadataModel.countDocuments(filter).exec(),
    ]);

    return { metadataList, total };
  }
}
