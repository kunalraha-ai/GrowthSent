import { Schema, model } from "mongoose";
import { IActivityLogDocument } from "../interfaces/activity_log.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const targetEntitySchema = new Schema(
  {
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
  },
  { _id: false }
);

const activityLogSchema = new Schema<IActivityLogDocument>(
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
      default: null,
      index: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    targetEntity: {
      type: targetEntitySchema,
    },
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
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
activityLogSchema.index({ projectId: 1, createdAt: -1 });
activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 }); // 365 days TTL

// Pre-validate hook to assign publicId before validation
activityLogSchema.pre("validate", function (this: IActivityLogDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_act_");
  }
});

export const ActivityLogModel = model<IActivityLogDocument>("ActivityLog", activityLogSchema);
