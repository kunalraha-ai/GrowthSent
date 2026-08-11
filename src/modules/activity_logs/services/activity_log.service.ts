import { ActivityLogRepository } from "../repositories/activity_log.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { CreateActivityLogDTO, QueryActivityLogDTO } from "../validators/activity_log.validator";
import { ActivityLogResponseDTO, toActivityLogResponseDTO } from "../dtos/activity_log.dto";
import { AppError } from "../../../shared/errors/appError";
import { IActivityLogDocument } from "../interfaces/activity_log.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";

export class ActivityLogService {
  constructor(
    private readonly activityLogRepository: ActivityLogRepository = new ActivityLogRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly userRepository: UserRepository = new UserRepository()
  ) {}

  async createActivityLog(dto: CreateActivityLogDTO): Promise<ActivityLogResponseDTO> {
    const project = await this.projectRepository.findByPublicId(dto.projectPublicId);
    if (!project) {
      throw new AppError("Project not found", 404);
    }

    let userId = undefined;
    if (dto.userPublicId) {
      const user = await this.userRepository.findByPublicId(dto.userPublicId);
      if (user) userId = user._id;
    }

    const newLog = await this.activityLogRepository.create({
      projectId: project._id,
      userId,
      action: dto.action,
      targetEntity: dto.targetEntity,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
      metadata: dto.metadata,
      schemaVersion: "1.0.0",
    });

    return toActivityLogResponseDTO(newLog, project.publicId, dto.userPublicId);
  }

  async getActivityLogByPublicId(publicId: string): Promise<ActivityLogResponseDTO> {
    const log = await this.activityLogRepository.findByPublicId(publicId);
    if (!log) {
      throw new AppError("Activity log entry not found", 404);
    }

    const projectPublicId = (log.projectId as unknown as IProjectDocument)?.publicId || "";
    const userPublicId = (log.userId as unknown as IUserDocument)?.publicId;

    return toActivityLogResponseDTO(log, projectPublicId, userPublicId);
  }

  async listActivityLogs(query: QueryActivityLogDTO): Promise<{ logs: ActivityLogResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.action) filter.action = query.action;

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { logs: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    if (query.userPublicId) {
      const user = await this.userRepository.findByPublicId(query.userPublicId);
      if (!user) return { logs: [], total: 0, page: query.page, limit: query.limit };
      filter.userId = user._id;
    }

    const { logs, total } = await this.activityLogRepository.list(filter, query.page, query.limit);

    const dtos = logs.map((log) => {
      const projectPublicId = (log.projectId as unknown as IProjectDocument)?.publicId || "";
      const userPublicId = (log.userId as unknown as IUserDocument)?.publicId;
      return toActivityLogResponseDTO(log, projectPublicId, userPublicId);
    });

    return {
      logs: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
