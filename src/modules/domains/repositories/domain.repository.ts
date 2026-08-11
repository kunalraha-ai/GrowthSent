import { DomainModel } from "../models/domain.model";
import { IDomain, IDomainDocument } from "../interfaces/domain.interface";
import { UpdateQuery, Types } from "mongoose";

export class DomainRepository {
  async create(domainData: Partial<IDomain>): Promise<IDomainDocument> {
    const domain = new DomainModel(domainData);
    return await domain.save();
  }

  async findByPublicId(publicId: string): Promise<IDomainDocument | null> {
    return await DomainModel.findOne({ publicId, state: { $ne: "deleted" as const } })
      .populate("projectId", "publicId")
      .exec();
  }

  async findByHostnameAndProject(hostname: string, projectId: Types.ObjectId): Promise<IDomainDocument | null> {
    return await DomainModel.findOne({
      hostname: hostname.toLowerCase().trim(),
      projectId,
      state: { $ne: "deleted" as const },
    })
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ domains: IDomainDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [domains, total] = await Promise.all([
      DomainModel.find(queryFilter)
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      DomainModel.countDocuments(queryFilter).exec(),
    ]);

    return { domains, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IDomainDocument>): Promise<IDomainDocument | null> {
    const domain = await DomainModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!domain) return null;

    Object.assign(domain, updateData);
    const updated = await domain.save();
    return await updated.populate("projectId", "publicId");
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const domain = await DomainModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!domain) return false;

    domain.state = "deleted";
    domain.deletedAt = new Date();
    await domain.save();
    return true;
  }
}
