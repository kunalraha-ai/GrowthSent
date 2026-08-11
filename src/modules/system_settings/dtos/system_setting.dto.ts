import { ISystemSetting } from "../interfaces/system_setting.interface";

export interface SystemSettingResponseDTO {
  publicId: string;
  key: string;
  value: unknown;
  description?: string;
  revision: number;
  updatedByUserPublicId?: string;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toSystemSettingResponseDTO(setting: ISystemSetting, updatedByUserPublicId?: string): SystemSettingResponseDTO {
  return {
    publicId: setting.publicId,
    key: setting.key,
    value: setting.value,
    description: setting.description,
    revision: setting.revision,
    updatedByUserPublicId,
    schemaVersion: setting.schemaVersion,
    createdAt: setting.createdAt,
    updatedAt: setting.updatedAt,
  };
}
