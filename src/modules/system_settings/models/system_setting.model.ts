import { Schema, model } from "mongoose";
import { ISystemSettingDocument } from "../interfaces/system_setting.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const systemSettingSchema = new Schema<ISystemSettingDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    value: {
      type: Schema.Types.Mixed,
      required: true,
    },
    description: {
      type: String,
      trim: true,
    },
    revision: {
      type: Number,
      default: 1,
      required: true,
    },
    updatedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

// Pre-validate hook to assign publicId before validation
systemSettingSchema.pre("validate", function (this: ISystemSettingDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_cfg_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
systemSettingSchema.pre("save", function (this: ISystemSettingDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const SystemSettingModel = model<ISystemSettingDocument>("SystemSetting", systemSettingSchema);
