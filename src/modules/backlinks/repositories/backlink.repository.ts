import { BacklinkModel } from "../models/backlink.model";
import { IBacklink, IBacklinkDocument } from "../interfaces/backlink.interface";
import { UpdateQuery, Types } from "mongoose";

export class BacklinkRepository {
  async create(backlinkData: Partial<IBacklink>): Promise<IBacklinkDocument> {
    const backlink = new BacklinkModel(backlinkData);
    return await backlink.save();
  }

  async findByPublicId(publicId: string): Promise<IBacklinkDocument | null> {
    return await BacklinkModel.findOne({ publicId, state: { $ne: "deleted" as const } })
      .populate("targetDomainId", "publicId")
      .populate("crawlSourceId", "publicId")
      .exec();
  }

  async findEdgeSignature(
    targetDomainId: Types.ObjectId,
    sourceUrlHash: string,
    targetUrlHash: string,
    snapshot: string
  ): Promise<IBacklinkDocument | null> {
    return await BacklinkModel.findOne({
      targetDomainId,
      sourceUrlHash,
      targetUrlHash,
      snapshot,
      state: { $ne: "deleted" as const },
    })
      .populate("targetDomainId", "publicId")
      .populate("crawlSourceId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ backlinks: IBacklinkDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [backlinks, total] = await Promise.all([
      BacklinkModel.find(queryFilter)
        .populate("targetDomainId", "publicId")
        .populate("crawlSourceId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      BacklinkModel.countDocuments(queryFilter).exec(),
    ]);

    return { backlinks, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IBacklinkDocument>): Promise<IBacklinkDocument | null> {
    const backlink = await BacklinkModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!backlink) return null;

    Object.assign(backlink, updateData);
    const updated = await backlink.save();
    return await updated.populate([
      { path: "targetDomainId", select: "publicId" },
      { path: "crawlSourceId", select: "publicId" },
    ]);
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const backlink = await BacklinkModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!backlink) return false;

    backlink.state = "deleted";
    backlink.isLost = true;
    backlink.deletedAt = new Date();
    await backlink.save();
    return true;
  }
}
