import { Schema, model } from "mongoose";
import { IAuditIssueDocument } from "../interfaces/audit_issue.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const aiSuggestedFixSchema = new Schema(
  {
    explanation: { type: String, trim: true },
    codeDiff: { type: String, trim: true },
    targetFile: { type: String, trim: true },
  },
  { _id: false }
);

const auditIssueSchema = new Schema<IAuditIssueDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    auditId: {
      type: Schema.Types.ObjectId,
      ref: "PageAudit",
      required: true,
      index: true,
    },
    pageId: {
      type: Schema.Types.ObjectId,
      ref: "Page",
      required: true,
      index: true,
    },
    domainId: {
      type: Schema.Types.ObjectId,
      ref: "Domain",
      required: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    ruleId: {
      type: String,
      required: true,
      trim: true,
    },
    severity: {
      type: String,
      enum: ["critical", "warning", "info"],
      default: "warning",
      required: true,
    },
    category: {
      type: String,
      enum: ["technical", "content", "mobile"],
      default: "technical",
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    details: {
      type: Schema.Types.Mixed,
    },
    state: {
      type: String,
      enum: ["open", "in_progress", "resolved", "suppressed"],
      default: "open",
      required: true,
    },
    assignedToUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    aiSuggestedFix: {
      type: aiSuggestedFixSchema,
    },
    schemaVersion: {
      type: String,
      default: "1.0.0",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes matching exact specification
auditIssueSchema.index({ auditId: 1 });
auditIssueSchema.index({ pageId: 1, state: 1 });
auditIssueSchema.index({ domainId: 1, state: 1, severity: 1 });
auditIssueSchema.index({ assignedToUserId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
auditIssueSchema.pre("validate", function (this: IAuditIssueDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_iss_");
  }
});

export const AuditIssueModel = model<IAuditIssueDocument>("AuditIssue", auditIssueSchema);
