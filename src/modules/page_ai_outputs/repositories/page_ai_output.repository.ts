import { PageAiOutputModel } from "../models/page_ai_output.model";
import { IPageAiOutput, IPageAiOutputDocument } from "../interfaces/page_ai_output.interface";
import { Types } from "mongoose";

export class PageAiOutputRepository {
  async create(aiData: Partial<IPageAiOutput>): Promise<IPageAiOutputDocument> {
    const aiOutput = new PageAiOutputModel(aiData);
    return await aiOutput.save();
  }

  async findByPublicId(publicId: string): Promise<IPageAiOutputDocument | null> {
    return await PageAiOutputModel.findOne({ publicId })
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async findByPageAndPromptHash(pageId: Types.ObjectId, promptHash: string): Promise<IPageAiOutputDocument | null> {
    return await PageAiOutputModel.findOne({ pageId, promptHash })
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ aiOutputs: IPageAiOutputDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [aiOutputs, total] = await Promise.all([
      PageAiOutputModel.find(filter)
        .populate("pageId", "publicId")
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      PageAiOutputModel.countDocuments(filter).exec(),
    ]);

    return { aiOutputs, total };
  }
}
