import { Ga4PropertyModel } from "../models/ga4_property.model";
import { IGa4Property, IGa4PropertyDocument } from "../interfaces/ga4_property.interface";
import { UpdateQuery, Types } from "mongoose";

export class Ga4PropertyRepository {
  async create(propertyData: Partial<IGa4Property>): Promise<IGa4PropertyDocument> {
    const prop = new Ga4PropertyModel(propertyData);
    return await prop.save();
  }

  async findByPublicId(publicId: string): Promise<IGa4PropertyDocument | null> {
    return await Ga4PropertyModel.findOne({ publicId })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByDomainAndPropertyId(domainId: Types.ObjectId, propertyId: string): Promise<IGa4PropertyDocument | null> {
    return await Ga4PropertyModel.findOne({ domainId, propertyId })
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ properties: IGa4PropertyDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [properties, total] = await Promise.all([
      Ga4PropertyModel.find(filter)
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      Ga4PropertyModel.countDocuments(filter).exec(),
    ]);

    return { properties, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IGa4PropertyDocument>): Promise<IGa4PropertyDocument | null> {
    const prop = await Ga4PropertyModel.findOne({ publicId });
    if (!prop) return null;

    Object.assign(prop, updateData);
    const updated = await prop.save();
    return await updated.populate([
      { path: "domainId", select: "publicId" },
      { path: "projectId", select: "publicId" },
    ]);
  }
}
