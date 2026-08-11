import { PageModel } from "../models/page.model";
import { IPage, IPageDocument } from "../interfaces/page.interface";
import { UpdateQuery, Types } from "mongoose";

export class PageRepository {
  async create(pageData: Partial<IPage>): Promise<IPageDocument> {
    const page = new PageModel(pageData);
    return await page.save();
  }

  async findByPublicId(publicId: string): Promise<IPageDocument | null> {
    return await PageModel.findOne({ publicId, state: { $ne: "deleted" as const } })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByUrlHash(domainId: Types.ObjectId, urlHash: string): Promise<IPageDocument | null> {
    return await PageModel.findOne({ domainId, urlHash, state: { $ne: "deleted" as const } })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ pages: IPageDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [pages, total] = await Promise.all([
      PageModel.find(queryFilter)
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      PageModel.countDocuments(queryFilter).exec(),
    ]);

    return { pages, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IPageDocument>): Promise<IPageDocument | null> {
    const page = await PageModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!page) return null;

    Object.assign(page, updateData);
    const updated = await page.save();
    return await updated.populate([
      { path: "domainId", select: "publicId" },
      { path: "projectId", select: "publicId" },
    ]);
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const page = await PageModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!page) return false;

    page.state = "deleted";
    page.deletedAt = new Date();
    await page.save();
    return true;
  }
}
