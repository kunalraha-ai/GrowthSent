import { SystemSettingModel } from "../models/system_setting.model";
import { ISystemSetting, ISystemSettingDocument } from "../interfaces/system_setting.interface";
import { Types } from "mongoose";

export class SystemSettingRepository {
  async upsertByKey(
    key: string,
    value: unknown,
    description?: string,
    updatedByUserId?: Types.ObjectId | null
  ): Promise<ISystemSettingDocument> {
    const existing = await SystemSettingModel.findOne({ key });
    if (existing) {
      existing.value = value;
      if (description !== undefined) existing.description = description;
      if (updatedByUserId !== undefined) existing.updatedByUserId = updatedByUserId;
      return await existing.save();
    }

    const newSetting = new SystemSettingModel({
      key,
      value,
      description,
      updatedByUserId,
      revision: 1,
      schemaVersion: "1.0.0",
    });
    return await newSetting.save();
  }

  async findByKey(key: string): Promise<ISystemSettingDocument | null> {
    return await SystemSettingModel.findOne({ key })
      .populate("updatedByUserId", "publicId")
      .exec();
  }

  async findByPublicId(publicId: string): Promise<ISystemSettingDocument | null> {
    return await SystemSettingModel.findOne({ publicId })
      .populate("updatedByUserId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ settings: ISystemSettingDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [settings, total] = await Promise.all([
      SystemSettingModel.find(filter)
        .populate("updatedByUserId", "publicId")
        .sort({ key: 1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      SystemSettingModel.countDocuments(filter).exec(),
    ]);

    return { settings, total };
  }
}
