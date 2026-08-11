import { Document, Types } from "mongoose";

export type ProjectMemberRole = "owner" | "admin" | "editor" | "viewer";
export type ProjectMemberState = "active" | "pending" | "deleted";

export interface IProjectMember {
  _id: Types.ObjectId;
  publicId: string;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  role: ProjectMemberRole;
  invitedByUserId: Types.ObjectId;
  joinedAt?: Date;
  state: ProjectMemberState;
  revision: number;
  deletedAt?: Date | null;
  schemaVersion: string;
  createdAt: Date;
}

export interface IProjectMemberDocument extends IProjectMember, Document<Types.ObjectId> {}
