import { Schema, model } from "mongoose";
import { IApiKeyDocument } from "../interfaces/api_key.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const apiKeySchema = new Schema<IApiKeyDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    keyPrefix: {
      type: String,
      required: true,
      trim: true,
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    permissions: {
      type: [String],
      default: ["*"],
      required: true,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    state: {
      type: String,
      enum: ["active", "revoked"],
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
apiKeySchema.index({ userId: 1, state: 1 });

// Pre-validate hook to assign publicId before validation
apiKeySchema.pre("validate", function (this: IApiKeyDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_key_");
  }
});

export const ApiKeyModel = model<IApiKeyDocument>("ApiKey", apiKeySchema);
