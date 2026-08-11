import { ActivityLogModel } from "../models/activity_log.model";
import { IActivityLog, IActivityLogDocument } from "../interfaces/activity_log.interface";

export class ActivityLogRepository {
  async create(logData: Partial<IActivityLog>): Promise<IActivityLogDocument> {
    const log = new ActivityLogModel(logData);
    return await log.save();
  }

  async findByPublicId(publicId: string): Promise<IActivityLogDocument | null> {
    return await ActivityLogModel.findOne({ publicId })
      .populate("projectId", "publicId")
      .populate("userId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ logs: IActivityLogDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      ActivityLogModel.find(filter)
        .populate("projectId", "publicId")
        .populate("userId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      ActivityLogModel.countDocuments(filter).exec(),
    ]);

    return { logs, total };
  }
}
