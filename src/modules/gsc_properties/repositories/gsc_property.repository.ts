import { GscPropertyModel } from "../models/gsc_property.model";
import { IGscProperty, IGscPropertyDocument } from "../interfaces/gsc_property.interface";
import { UpdateQuery, Types } from "mongoose";

export class GscPropertyRepository {
  async create(propertyData: Partial<IGscProperty>): Promise<IGscPropertyDocument> {
    const prop = new GscPropertyModel(propertyData);
    return await prop.save();
  }

  async findByPublicId(publicId: string): Promise<IGscPropertyDocument | null> {
    return await GscPropertyModel.findOne({ publicId })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByDomainAndSiteUrl(domainId: Types.ObjectId, siteUrl: string): Promise<IGscPropertyDocument | null> {
    return await GscPropertyModel.findOne({ domainId, siteUrl })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ properties: IGscPropertyDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [properties, total] = await Promise.all([
      GscPropertyModel.find(filter)
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      GscPropertyModel.countDocuments(filter).exec(),
    ]);

    return { properties, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IGscPropertyDocument>): Promise<IGscPropertyDocument | null> {
    const prop = await GscPropertyModel.findOne({ publicId });
    if (!prop) return null;

    Object.assign(prop, updateData);
    const updated = await prop.save();
    return await updated.populate([
      { path: "domainId", select: "publicId" },
      { path: "projectId", select: "publicId" },
    ]);
  }
}
