import { Schema, model } from "mongoose";
import { IProjectMemberDocument } from "../interfaces/project_member.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const projectMemberSchema = new Schema<IProjectMemberDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "editor", "viewer"],
      default: "viewer",
      required: true,
    },
    invitedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    joinedAt: {
      type: Date,
    },
    state: {
      type: String,
      enum: ["active", "pending", "deleted"],
      default: "pending",
      required: true,
    },
    revision: {
      type: Number,
      default: 1,
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    schemaVersion: {
      type: String,
      default: "1.0.0",
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes matching exact specification
projectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });
projectMemberSchema.index({ userId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
projectMemberSchema.pre("validate", function (this: IProjectMemberDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_mem_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
projectMemberSchema.pre("save", function (this: IProjectMemberDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const ProjectMemberModel = model<IProjectMemberDocument>("ProjectMember", projectMemberSchema);
