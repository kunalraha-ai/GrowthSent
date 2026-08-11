import { IActivityLog, ITargetEntity } from "../interfaces/activity_log.interface";

export interface ActivityLogResponseDTO {
  publicId: string;
  projectPublicId: string;
  userPublicId?: string;
  action: string;
  targetEntity?: ITargetEntity;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  schemaVersion: string;
  createdAt: Date;
}

export function toActivityLogResponseDTO(
  log: IActivityLog,
  projectPublicId: string,
  userPublicId?: string
): ActivityLogResponseDTO {
  return {
    publicId: log.publicId,
    projectPublicId,
    userPublicId,
    action: log.action,
    targetEntity: log.targetEntity,
    ipAddress: log.ipAddress,
    userAgent: log.userAgent,
    metadata: log.metadata,
    schemaVersion: log.schemaVersion,
    createdAt: log.createdAt,
  };
}
