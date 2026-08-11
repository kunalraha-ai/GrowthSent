import { IApiKey, ApiKeyState } from "../interfaces/api_key.interface";

export interface ApiKeyResponseDTO {
  publicId: string;
  userPublicId: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  state: ApiKeyState;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyCreatedResponseDTO extends ApiKeyResponseDTO {
  rawKey: string;
}

export function toApiKeyResponseDTO(apiKey: IApiKey, userPublicId: string): ApiKeyResponseDTO {
  return {
    publicId: apiKey.publicId,
    userPublicId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    permissions: apiKey.permissions,
    expiresAt: apiKey.expiresAt,
    lastUsedAt: apiKey.lastUsedAt,
    state: apiKey.state,
    schemaVersion: apiKey.schemaVersion,
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
  };
}
