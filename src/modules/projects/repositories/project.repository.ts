import { ProjectModel } from "../models/project.model";
import { IProject, IProjectDocument } from "../interfaces/project.interface";
import { UpdateQuery, Types } from "mongoose";

export class ProjectRepository {
  async create(projectData: Partial<IProject>): Promise<IProjectDocument> {
    const project = new ProjectModel(projectData);
    return await project.save();
  }

  async findByPublicId(publicId: string): Promise<IProjectDocument | null> {
    return await ProjectModel.findOne({ publicId, state: { $ne: "deleted" as const } })
      .populate("ownerId", "publicId")
      .exec();
  }

  async findByObjectId(id: Types.ObjectId | string): Promise<IProjectDocument | null> {
    return await ProjectModel.findById(id).exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ projects: IProjectDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const queryFilter = { ...filter, state: { $ne: "deleted" as const } };

    const [projects, total] = await Promise.all([
      ProjectModel.find(queryFilter)
        .populate("ownerId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      ProjectModel.countDocuments(queryFilter).exec(),
    ]);

    return { projects, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IProjectDocument>): Promise<IProjectDocument | null> {
    const project = await ProjectModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!project) return null;

    Object.assign(project, updateData);
    const updated = await project.save();
    return await updated.populate("ownerId", "publicId");
  }

  async softDeleteByPublicId(publicId: string): Promise<boolean> {
    const project = await ProjectModel.findOne({ publicId, state: { $ne: "deleted" as const } });
    if (!project) return false;

    project.state = "deleted";
    project.deletedAt = new Date();
    await project.save();
    return true;
  }
}
