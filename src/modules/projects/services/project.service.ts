import { ProjectRepository } from "../repositories/project.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { CreateProjectDTO, UpdateProjectDTO, QueryProjectDTO } from "../validators/project.validator";
import { ProjectResponseDTO, toProjectResponseDTO } from "../dtos/project.dto";
import { AppError } from "../../../shared/errors/appError";
import { IProjectDocument } from "../interfaces/project.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";

export class ProjectService {
  constructor(
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly userRepository: UserRepository = new UserRepository()
  ) {}

  async createProject(dto: CreateProjectDTO): Promise<ProjectResponseDTO> {
    const owner = await this.userRepository.findByPublicId(dto.ownerPublicId);
    if (!owner) {
      throw new AppError("Owner user not found", 404);
    }

    const newProject = await this.projectRepository.create({
      name: dto.name,
      ownerId: owner._id,
      settings: dto.settings || { defaultScanFrequencyHours: 24 },
      state: "active",
      schemaVersion: "1.0.0",
      revision: 1,
    });

    return toProjectResponseDTO(newProject, owner.publicId);
  }

  async getProjectByPublicId(publicId: string): Promise<ProjectResponseDTO> {
    const project = await this.projectRepository.findByPublicId(publicId);
    if (!project) {
      throw new AppError("Project not found", 404);
    }

    const ownerPublicId = (project.ownerId as unknown as IUserDocument)?.publicId || "";
    return toProjectResponseDTO(project, ownerPublicId);
  }

  async getProjectByObjectId(objectId: string): Promise<IProjectDocument> {
    const project = await this.projectRepository.findByObjectId(objectId);
    if (!project || project.state === "deleted") {
      throw new AppError("Project not found", 404);
    }
    return project;
  }

  async listProjects(query: QueryProjectDTO): Promise<{ projects: ProjectResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) {
      filter.state = query.state;
    }

    if (query.ownerPublicId) {
      const owner = await this.userRepository.findByPublicId(query.ownerPublicId);
      if (!owner) {
        return { projects: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.ownerId = owner._id;
    }

    const { projects, total } = await this.projectRepository.list(filter, query.page, query.limit);

    const projectDtos = projects.map((project) => {
      const ownerPublicId = (project.ownerId as unknown as IUserDocument)?.publicId || "";
      return toProjectResponseDTO(project, ownerPublicId);
    });

    return {
      projects: projectDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateProject(publicId: string, dto: UpdateProjectDTO): Promise<ProjectResponseDTO> {
    const existing = await this.projectRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Project not found", 404);
    }

    const updated = await this.projectRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update project", 500);
    }

    const ownerPublicId = (updated.ownerId as unknown as IUserDocument)?.publicId || "";
    return toProjectResponseDTO(updated, ownerPublicId);
  }

  async deleteProject(publicId: string): Promise<void> {
    const deleted = await this.projectRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("Project not found", 404);
    }
  }
}
