import { ProjectMemberRepository } from "../repositories/project_member.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { AddProjectMemberDTO, UpdateProjectMemberDTO, QueryProjectMemberDTO } from "../validators/project_member.validator";
import { ProjectMemberResponseDTO, toProjectMemberResponseDTO } from "../dtos/project_member.dto";
import { AppError } from "../../../shared/errors/appError";
import { IProjectMemberDocument } from "../interfaces/project_member.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";

export class ProjectMemberService {
  constructor(
    private readonly projectMemberRepository: ProjectMemberRepository = new ProjectMemberRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly userRepository: UserRepository = new UserRepository()
  ) {}

  async addMember(dto: AddProjectMemberDTO): Promise<ProjectMemberResponseDTO> {
    const project = await this.projectRepository.findByPublicId(dto.projectPublicId);
    if (!project) {
      throw new AppError("Project not found", 404);
    }

    const user = await this.userRepository.findByPublicId(dto.userPublicId);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    const invitedByUser = await this.userRepository.findByPublicId(dto.invitedByUserPublicId);
    if (!invitedByUser) {
      throw new AppError("Inviting user not found", 404);
    }

    const existingMember = await this.projectMemberRepository.findByProjectAndUser(project._id, user._id);
    if (existingMember) {
      throw new AppError("User is already a member of this project", 409);
    }

    const newMember = await this.projectMemberRepository.create({
      projectId: project._id,
      userId: user._id,
      role: dto.role,
      invitedByUserId: invitedByUser._id,
      joinedAt: new Date(),
      state: "active",
      schemaVersion: "1.0.0",
      revision: 1,
    });

    return toProjectMemberResponseDTO(newMember, project.publicId, user.publicId, invitedByUser.publicId);
  }

  async getMemberByPublicId(publicId: string): Promise<ProjectMemberResponseDTO> {
    const member = await this.projectMemberRepository.findByPublicId(publicId);
    if (!member) {
      throw new AppError("Project member not found", 404);
    }

    const projectPublicId = (member.projectId as unknown as IProjectDocument)?.publicId || "";
    const userPublicId = (member.userId as unknown as IUserDocument)?.publicId || "";
    const invitedByUserPublicId = (member.invitedByUserId as unknown as IUserDocument)?.publicId || "";

    return toProjectMemberResponseDTO(member, projectPublicId, userPublicId, invitedByUserPublicId);
  }

  async listMembers(query: QueryProjectMemberDTO): Promise<{ members: ProjectMemberResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) {
      filter.state = query.state;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) {
        return { members: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.projectId = project._id;
    }

    if (query.userPublicId) {
      const user = await this.userRepository.findByPublicId(query.userPublicId);
      if (!user) {
        return { members: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.userId = user._id;
    }

    const { members, total } = await this.projectMemberRepository.list(filter, query.page, query.limit);

    const memberDtos = members.map((member) => {
      const projectPublicId = (member.projectId as unknown as IProjectDocument)?.publicId || "";
      const userPublicId = (member.userId as unknown as IUserDocument)?.publicId || "";
      const invitedByUserPublicId = (member.invitedByUserId as unknown as IUserDocument)?.publicId || "";
      return toProjectMemberResponseDTO(member, projectPublicId, userPublicId, invitedByUserPublicId);
    });

    return {
      members: memberDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateMember(publicId: string, dto: UpdateProjectMemberDTO): Promise<ProjectMemberResponseDTO> {
    const existing = await this.projectMemberRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Project member not found", 404);
    }

    const updated = await this.projectMemberRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update project member", 500);
    }

    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";
    const userPublicId = (updated.userId as unknown as IUserDocument)?.publicId || "";
    const invitedByUserPublicId = (updated.invitedByUserId as unknown as IUserDocument)?.publicId || "";

    return toProjectMemberResponseDTO(updated, projectPublicId, userPublicId, invitedByUserPublicId);
  }

  async removeMember(publicId: string): Promise<void> {
    const deleted = await this.projectMemberRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("Project member not found", 404);
    }
  }
}
