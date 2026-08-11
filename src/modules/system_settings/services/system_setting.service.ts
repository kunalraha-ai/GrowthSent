import { SystemSettingRepository } from "../repositories/system_setting.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { UpsertSystemSettingDTO, QuerySystemSettingDTO } from "../validators/system_setting.validator";
import { SystemSettingResponseDTO, toSystemSettingResponseDTO } from "../dtos/system_setting.dto";
import { AppError } from "../../../shared/errors/appError";
import { ISystemSettingDocument } from "../interfaces/system_setting.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";

export class SystemSettingService {
  constructor(
    private readonly systemSettingRepository: SystemSettingRepository = new SystemSettingRepository(),
    private readonly userRepository: UserRepository = new UserRepository()
  ) {}

  async upsertSystemSetting(dto: UpsertSystemSettingDTO): Promise<SystemSettingResponseDTO> {
    let updatedByUserId = undefined;
    if (dto.updatedByUserPublicId) {
      const user = await this.userRepository.findByPublicId(dto.updatedByUserPublicId);
      if (user) updatedByUserId = user._id;
    }

    const updated = await this.systemSettingRepository.upsertByKey(
      dto.key,
      dto.value,
      dto.description,
      updatedByUserId
    );

    return toSystemSettingResponseDTO(updated, dto.updatedByUserPublicId);
  }

  async getSystemSettingByKey(key: string): Promise<SystemSettingResponseDTO> {
    const setting = await this.systemSettingRepository.findByKey(key);
    if (!setting) {
      throw new AppError("System setting key not found", 404);
    }

    const updatedByUserPublicId = (setting.updatedByUserId as unknown as IUserDocument)?.publicId;

    return toSystemSettingResponseDTO(setting, updatedByUserPublicId);
  }

  async listSystemSettings(query: QuerySystemSettingDTO): Promise<{ settings: SystemSettingResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.key) filter.key = new RegExp(query.key, "i");

    const { settings, total } = await this.systemSettingRepository.list(filter, query.page, query.limit);

    const dtos = settings.map((s) => {
      const updatedByUserPublicId = (s.updatedByUserId as unknown as IUserDocument)?.publicId;
      return toSystemSettingResponseDTO(s, updatedByUserPublicId);
    });

    return {
      settings: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
