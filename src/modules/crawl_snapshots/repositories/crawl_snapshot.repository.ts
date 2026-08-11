import { CrawlSnapshotModel } from "../models/crawl_snapshot.model";
import { ICrawlSnapshot, ICrawlSnapshotDocument } from "../interfaces/crawl_snapshot.interface";
import { Types } from "mongoose";

export class CrawlSnapshotRepository {
  async create(snapshotData: Partial<ICrawlSnapshot>): Promise<ICrawlSnapshotDocument> {
    const snapshot = new CrawlSnapshotModel(snapshotData);
    return await snapshot.save();
  }

  async findByPublicId(publicId: string): Promise<ICrawlSnapshotDocument | null> {
    return await CrawlSnapshotModel.findOne({ publicId })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("crawlJobId", "publicId")
      .exec();
  }

  async findByDomainAndSnapshotTag(domainId: Types.ObjectId, snapshot: string): Promise<ICrawlSnapshotDocument | null> {
    return await CrawlSnapshotModel.findOne({ domainId, snapshot })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("crawlJobId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ snapshots: ICrawlSnapshotDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [snapshots, total] = await Promise.all([
      CrawlSnapshotModel.find(filter)
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .populate("crawlJobId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      CrawlSnapshotModel.countDocuments(filter).exec(),
    ]);

    return { snapshots, total };
  }
}
