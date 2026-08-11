import { Schema, model } from "mongoose";
import { IGa4PropertyDocument } from "../interfaces/ga4_property.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const encryptedCredentialsSchema = new Schema(
  {
    encryptedData: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
  },
  { _id: false }
);

const ga4PropertySchema = new Schema<IGa4PropertyDocument>(
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
    propertyId: {
      type: String,
      required: true,
      trim: true,
    },
    measurementId: {
      type: String,
      trim: true,
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
ga4PropertySchema.index({ domainId: 1, propertyId: 1 }, { unique: true });
ga4PropertySchema.index({ projectId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
ga4PropertySchema.pre("validate", function (this: IGa4PropertyDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_ga4_");
  }
});

export const Ga4PropertyModel = model<IGa4PropertyDocument>("Ga4Property", ga4PropertySchema);
