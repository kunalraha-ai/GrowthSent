import { Schema, model } from "mongoose";
import { IUserDocument } from "../interfaces/user.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const authProviderSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["email", "google"],
      required: true,
    },
    providerId: {
      type: String,
      required: true,
    },
    linkedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const userMetadataSchema = new Schema(
  {
    signupIp: { type: String },
    lastLoginAt: { type: Date },
    loginCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const userSchema = new Schema<IUserDocument>(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      enum: ["active", "suspended", "pending", "deleted"],
      default: "active",
      required: true,
    },
    authProviders: {
      type: [authProviderSchema],
      default: [],
      validate: [
        (val: unknown[]) => val.length <= 5,
        "authProviders array exceeds maximum allowed length of 5",
      ],
    },
    metadata: {
      type: userMetadataSchema,
      default: () => ({ loginCount: 0 }),
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
userSchema.index({ email: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
userSchema.index({ state: 1, createdAt: -1 });

// Pre-validate hook to assign publicId before validation
userSchema.pre("validate", function (this: IUserDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_usr_");
  }
});

// Pre-save hook to handle optimistic concurrency revision
userSchema.pre("save", function (this: IUserDocument) {
  if (!this.isNew) {
    this.revision += 1;
  }
});

export const UserModel = model<IUserDocument>("User", userSchema);
