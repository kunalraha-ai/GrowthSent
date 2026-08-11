import { IProject, ProjectState } from "../interfaces/project.interface";

export interface ProjectResponseDTO {
  publicId: string;
  name: string;
  ownerPublicId: string;
  settings: {
    defaultScanFrequencyHours?: number;
    alertWebhookUrl?: string;
  };
  state: ProjectState;
  revision: number;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toProjectResponseDTO(project: IProject, ownerPublicId: string): ProjectResponseDTO {
  return {
    publicId: project.publicId,
    name: project.name,
    ownerPublicId,
    settings: {
      defaultScanFrequencyHours: project.settings?.defaultScanFrequencyHours,
      alertWebhookUrl: project.settings?.alertWebhookUrl,
    },
    state: project.state,
    revision: project.revision,
    schemaVersion: project.schemaVersion,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}
