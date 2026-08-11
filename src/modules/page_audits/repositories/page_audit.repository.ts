import { PageAuditModel } from "../models/page_audit.model";
import { IPageAudit, IPageAuditDocument } from "../interfaces/page_audit.interface";
import { Types } from "mongoose";

export class PageAuditRepository {
  async create(auditData: Partial<IPageAudit>): Promise<IPageAuditDocument> {
    const audit = new PageAuditModel(auditData);
    return await audit.save();
  }

  async findByPublicId(publicId: string): Promise<IPageAuditDocument | null> {
    return await PageAuditModel.findOne({ publicId })
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("crawlJobId", "publicId")
      .exec();
  }

  async findByPageCrawlAndAlgorithm(
    pageId: Types.ObjectId,
    crawlJobId: Types.ObjectId,
    algorithmVersion: string
  ): Promise<IPageAuditDocument | null> {
    return await PageAuditModel.findOne({ pageId, crawlJobId, algorithmVersion })
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("crawlJobId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ audits: IPageAuditDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [audits, total] = await Promise.all([
      PageAuditModel.find(filter)
        .populate("pageId", "publicId")
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .populate("crawlJobId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      PageAuditModel.countDocuments(filter).exec(),
    ]);

    return { audits, total };
  }
}
