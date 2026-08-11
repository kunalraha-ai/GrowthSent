import { ProjectMemberModel } from "../models/project_member.model";
import { IProjectMember, IProjectMemberDocument } from "../interfaces/project_member.interface";
import { UpdateQuery, Types } from "mongoose";

export class ProjectMemberRepository {
  async create(memberData: Partial<IProjectMember>): Promise<IProjectMemberDocument> {
    const member = new ProjectMemberModel(memberData);
    return await member.save();
  }

  async findByPublicId(publicId: string): Promise<IProjectMemberDocument | null> {
    return await ProjectMemberModel.findOne({ publicId, state: { $ne: "deleted" as const } })
      .populate("projectId", "publicId")
      .populate("userId", "publicId")
      .populate("invitedByUserId", "publicId")
      .exec();
  }

  async findByProjectAndUser(projectId: Types.ObjectId, userId: Types.ObjectId): Promise<IProjectMemberDocument | null> {
    return await ProjectMemberModel.findOne({ projectId, userId, state: { $ne: "deleted" as const } })
      .populate("projectId", "publicId")
      .populate("userId", "publicId")
      .populate("invitedByUserId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ members: IProjectMemberDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [members, total] = await Promise.all([
      ProjectMemberModel.find(queryFilter)
        .populate("projectId", "publicId")
        .populate("userId", "publicId")
        .populate("invitedByUserId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      ProjectMemberModel.countDocuments(queryFilter).exec(),
    ]);

    return { members, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IProjectMemberDocument>): Promise<IProjectMemberDocument | null> {
    const member = await ProjectMemberModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!member) return null;

    Object.assign(member, updateData);
    const updated = await member.save();
    return await updated.populate([
      { path: "projectId", select: "publicId" },
      { path: "userId", select: "publicId" },
      { path: "invitedByUserId", select: "publicId" },
    ]);
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const member = await ProjectMemberModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!member) return false;

    member.state = "deleted";
    member.deletedAt = new Date();
    await member.save();
    return true;
  }
}
