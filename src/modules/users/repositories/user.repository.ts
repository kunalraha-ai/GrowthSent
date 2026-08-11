import { UpdateQuery } from "mongoose";
import { UserModel } from "../models/user.model";
import { IUser, IUserDocument } from "../interfaces/user.interface";

export class UserRepository {
  async create(userData: Partial<IUser>): Promise<IUserDocument> {
    const user = new UserModel(userData);
    return await user.save();
  }

  async findByPublicId(publicId: string): Promise<IUserDocument | null> {
    return await UserModel.findOne({ publicId, state: { $ne: "deleted" as const } }).exec();
  }

  async findByEmail(email: string): Promise<IUserDocument | null> {
    return await UserModel.findOne({
      email: email.toLowerCase().trim(),
      state: { $ne: "deleted" as const },
    }).exec();
  }

  async findByObjectId(id: string): Promise<IUserDocument | null> {
    return await UserModel.findById(id).exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ users: IUserDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [users, total] = await Promise.all([
      UserModel.find(queryFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      UserModel.countDocuments(queryFilter).exec(),
    ]);

    return { users, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IUserDocument>): Promise<IUserDocument | null> {
    const user = await UserModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!user) return null;

    Object.assign(user, updateData);
    return await user.save();
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const user = await UserModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!user) return false;

    user.state = "deleted";
    user.deletedAt = new Date();
    await user.save();
    return true;
  }
}
