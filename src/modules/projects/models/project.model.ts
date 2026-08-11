import { Schema, model } from "mongoose";
import { IProjectDocument } from "../interfaces/project.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const projectSettingsSchema = new Schema(
  {
    defaultScanFrequencyHours: { type: Number, default: 24 },
    alertWebhookUrl: { type: String },
  },
  { _id: false }
);

const projectSchema = new Schema<IProjectDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    settings: {
      type: projectSettingsSchema,
      default: () => ({ defaultScanFrequencyHours: 24 }),
    },
    state: {
      type: String,
      enum: ["active", "archived", "deleted"],
      default: "active",
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
    timestamps: true,
  }
);

// Indexes matching exact specification
projectSchema.index({ ownerId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
projectSchema.pre("validate", function (this: IProjectDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_prj_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
projectSchema.pre("save", function (this: IProjectDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const ProjectModel = model<IProjectDocument>("Project", projectSchema);
