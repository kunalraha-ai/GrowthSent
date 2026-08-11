import { IProjectMember, ProjectMemberRole, ProjectMemberState } from "../interfaces/project_member.interface";

export interface ProjectMemberResponseDTO {
  publicId: string;
  projectPublicId: string;
  userPublicId: string;
  role: ProjectMemberRole;
  invitedByUserPublicId: string;
  joinedAt?: Date;
  state: ProjectMemberState;
  revision: number;
  schemaVersion: string;
  createdAt: Date;
}

export function toProjectMemberResponseDTO(
  member: IProjectMember,
  projectPublicId: string,
  userPublicId: string,
  invitedByUserPublicId: string
): ProjectMemberResponseDTO {
  return {
    publicId: member.publicId,
    projectPublicId,
    userPublicId,
    role: member.role,
    invitedByUserPublicId,
    joinedAt: member.joinedAt,
    state: member.state,
    revision: member.revision,
    schemaVersion: member.schemaVersion,
    createdAt: member.createdAt,
  };
}
