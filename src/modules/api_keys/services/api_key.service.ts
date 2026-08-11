import { ApiKeyRepository } from "../repositories/api_key.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { CreateApiKeyDTO, UpdateApiKeyDTO, QueryApiKeyDTO, generateRawApiKey } from "../validators/api_key.validator";
import { ApiKeyResponseDTO, ApiKeyCreatedResponseDTO, toApiKeyResponseDTO } from "../dtos/api_key.dto";
import { AppError } from "../../../shared/errors/appError";
import { IApiKeyDocument } from "../interfaces/api_key.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";

export class ApiKeyService {
  constructor(
    private readonly apiKeyRepository: ApiKeyRepository = new ApiKeyRepository(),
    private readonly userRepository: UserRepository = new UserRepository()
  ) {}

  async createApiKey(dto: CreateApiKeyDTO): Promise<ApiKeyCreatedResponseDTO> {
    const user = await this.userRepository.findByPublicId(dto.userPublicId);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    const { rawKey, keyPrefix, keyHash } = generateRawApiKey();

    const newKey = await this.apiKeyRepository.create({
      userId: user._id,
      name: dto.name,
      keyPrefix,
      keyHash,
      permissions: dto.permissions || ["*"],
      expiresAt: dto.expiresAt,
      state: "active",
      schemaVersion: "1.0.0",
    });

    const dtoResponse = toApiKeyResponseDTO(newKey, user.publicId);
    return {
      ...dtoResponse,
      rawKey,
    };
  }

  async getApiKeyByPublicId(publicId: string): Promise<ApiKeyResponseDTO> {
    const key = await this.apiKeyRepository.findByPublicId(publicId);
    if (!key) {
      throw new AppError("API key not found", 404);
    }

    const userPublicId = (key.userId as unknown as IUserDocument)?.publicId || "";

    return toApiKeyResponseDTO(key, userPublicId);
  }

  async listApiKeys(query: QueryApiKeyDTO): Promise<{ apiKeys: ApiKeyResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) filter.state = query.state;

    if (query.userPublicId) {
      const user = await this.userRepository.findByPublicId(query.userPublicId);
      if (!user) return { apiKeys: [], total: 0, page: query.page, limit: query.limit };
      filter.userId = user._id;
    }

    const { apiKeys, total } = await this.apiKeyRepository.list(filter, query.page, query.limit);

    const dtos = apiKeys.map((key) => {
      const userPublicId = (key.userId as unknown as IUserDocument)?.publicId || "";
      return toApiKeyResponseDTO(key, userPublicId);
    });

    return {
      apiKeys: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateApiKey(publicId: string, dto: UpdateApiKeyDTO): Promise<ApiKeyResponseDTO> {
    const existing = await this.apiKeyRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("API key not found", 404);
    }

    const updated = await this.apiKeyRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update API key", 500);
    }

    const userPublicId = (updated.userId as unknown as IUserDocument)?.publicId || "";

    return toApiKeyResponseDTO(updated, userPublicId);
  }

  async revokeApiKey(publicId: string): Promise<ApiKeyResponseDTO> {
    return await this.updateApiKey(publicId, { state: "revoked" });
  }
}
