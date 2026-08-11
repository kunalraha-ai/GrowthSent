import { Document, Types } from "mongoose";

export type UserState = "active" | "suspended" | "pending" | "deleted";
export type AuthProviderType = "email" | "google";

export interface IAuthProvider {
  provider: AuthProviderType;
  providerId: string;
  linkedAt: Date;
}

export interface IUserMetadata {
  signupIp?: string;
  lastLoginAt?: Date;
  loginCount: number;
}

export interface IUser {
  _id: Types.ObjectId;
  publicId: string;
  email: string;
  passwordHash?: string;
  name: string;
  state: UserState;
  authProviders: IAuthProvider[];
  metadata: IUserMetadata;
  revision: number;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserDocument extends IUser, Document<Types.ObjectId> {}
