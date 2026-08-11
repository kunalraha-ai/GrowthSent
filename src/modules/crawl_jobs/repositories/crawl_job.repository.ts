import { CrawlJobModel } from "../models/crawl_job.model";
import { ICrawlJob, ICrawlJobDocument } from "../interfaces/crawl_job.interface";
import { UpdateQuery } from "mongoose";

export class CrawlJobRepository {
  async create(jobData: Partial<ICrawlJob>): Promise<ICrawlJobDocument> {
    const job = new CrawlJobModel(jobData);
    return await job.save();
  }

  async findByPublicId(publicId: string): Promise<ICrawlJobDocument | null> {
    return await CrawlJobModel.findOne({ publicId })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("triggeredByUserId", "publicId")
      .populate("crawlSourceId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ jobs: ICrawlJobDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      CrawlJobModel.find(filter)
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .populate("triggeredByUserId", "publicId")
        .populate("crawlSourceId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      CrawlJobModel.countDocuments(filter).exec(),
    ]);

    return { jobs, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<ICrawlJobDocument>): Promise<ICrawlJobDocument | null> {
    const job = await CrawlJobModel.findOne({ publicId });
    if (!job) return null;

    Object.assign(job, updateData);
    const updated = await job.save();
    return await updated.populate([
      { path: "domainId", select: "publicId" },
      { path: "projectId", select: "publicId" },
      { path: "triggeredByUserId", select: "publicId" },
      { path: "crawlSourceId", select: "publicId" },
    ]);
  }
}
