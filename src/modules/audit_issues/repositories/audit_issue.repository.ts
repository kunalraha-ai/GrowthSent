import { AuditIssueModel } from "../models/audit_issue.model";
import { IAuditIssue, IAuditIssueDocument } from "../interfaces/audit_issue.interface";
import { UpdateQuery } from "mongoose";

export class AuditIssueRepository {
  async create(issueData: Partial<IAuditIssue>): Promise<IAuditIssueDocument> {
    const issue = new AuditIssueModel(issueData);
    return await issue.save();
  }

  async findByPublicId(publicId: string): Promise<IAuditIssueDocument | null> {
    return await AuditIssueModel.findOne({ publicId })
      .populate("auditId", "publicId")
      .populate("pageId", "publicId")
      .populate("domainId", "publicId")
      .populate("projectId", "publicId")
      .populate("assignedToUserId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ issues: IAuditIssueDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [issues, total] = await Promise.all([
      AuditIssueModel.find(filter)
        .populate("auditId", "publicId")
        .populate("pageId", "publicId")
        .populate("domainId", "publicId")
        .populate("projectId", "publicId")
        .populate("assignedToUserId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      AuditIssueModel.countDocuments(filter).exec(),
    ]);

    return { issues, total };
  }

  async updateByPublicId(publicId: string, updateData: UpdateQuery<IAuditIssueDocument>): Promise<IAuditIssueDocument | null> {
    const issue = await AuditIssueModel.findOne({ publicId });
    if (!issue) return null;

    Object.assign(issue, updateData);
    const updated = await issue.save();
    return await updated.populate([
      { path: "auditId", select: "publicId" },
      { path: "pageId", select: "publicId" },
      { path: "domainId", select: "publicId" },
      { path: "projectId", select: "publicId" },
      { path: "assignedToUserId", select: "publicId" },
    ]);
  }
}
