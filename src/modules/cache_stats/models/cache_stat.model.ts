import { Schema, model } from "mongoose";
import { ICacheStatDocument } from "../interfaces/cache_stat.interface";
import { generatePublicId } from "../../../shared/utils/publicId";

const cacheStatSchema = new Schema<ICacheStatDocument>(
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
    key: {
      type: String,
      required: true,
      trim: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    expiresAt: {
      type: Date,
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
cacheStatSchema.index({ domainId: 1, key: 1 }, { unique: true });
cacheStatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Dynamic TTL index

// Pre-validate hook to assign publicId before validation
cacheStatSchema.pre("validate", function (this: ICacheStatDocument) {
  if (!this.publicId) {
    this.publicId = generatePublicId("gs_cch_");
  }
});

export const CacheStatModel = model<ICacheStatDocument>("CacheStat", cacheStatSchema);
