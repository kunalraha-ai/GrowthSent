import { Schema, model } from "mongoose";
import { IGscPropertyDocument } from "../interfaces/gsc_property.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const encryptedCredentialsSchema = new Schema(
  {
    encryptedData: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
  },
  { _id: false }
);

const gscPropertySchema = new Schema<IGscPropertyDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
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
    siteUrl: {
      type: String,
      required: true,
      trim: true,
    },
    permissionLevel: {
      type: String,
      enum: ["siteOwner", "siteFullUser", "siteRestrictedUser"],
      default: "siteOwner",
      required: true,
    },
    encryptedCredentials: {
      type: encryptedCredentialsSchema,
      required: true,
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
    state: {
      type: String,
      enum: ["active", "error", "revoked"],
      default: "active",
      required: true,
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
gscPropertySchema.index({ domainId: 1, siteUrl: 1 }, { unique: true });
gscPropertySchema.index({ projectId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
gscPropertySchema.pre("validate", function (this: IGscPropertyDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_gsc_");
  }
});

export const GscPropertyModel = model<IGscPropertyDocument>("GscProperty", gscPropertySchema);
