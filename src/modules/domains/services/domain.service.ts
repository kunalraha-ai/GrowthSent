import { DomainRepository } from "../repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CreateDomainDTO, UpdateDomainDTO, QueryDomainDTO, extractApexDomain } from "../validators/domain.validator";
import { DomainResponseDTO, toDomainResponseDTO } from "../dtos/domain.dto";
import { AppError } from "../../../shared/errors/appError";
import { IDomainDocument } from "../interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class DomainService {
  constructor(
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async createDomain(dto: CreateDomainDTO): Promise<DomainResponseDTO> {
    const project = await this.projectRepository.findByPublicId(dto.projectPublicId);
    if (!project) {
      throw new AppError("Project not found", 404);
    }

    const existingDomain = await this.domainRepository.findByHostnameAndProject(dto.hostname, project._id);
    if (existingDomain) {
      throw new AppError("Domain hostname already exists in this project", 409);
    }

    const apexDomain = extractApexDomain(dto.hostname);

    const newDomain = await this.domainRepository.create({
      projectId: project._id,
      hostname: dto.hostname,
      apexDomain,
      scheme: dto.scheme || "https",
      serverHeader: dto.serverHeader,
      verificationMethods: [],
      state: "active",
      schemaVersion: "1.0.0",
      revision: 1,
    });

    return toDomainResponseDTO(newDomain, project.publicId);
  }

  async getDomainByPublicId(publicId: string): Promise<DomainResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(publicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toDomainResponseDTO(domain, projectPublicId);
  }

  async getDomainByObjectId(objectId: string): Promise<IDomainDocument> {
    const domain = await this.domainRepository.findByPublicId(objectId);
    if (!domain || domain.state === "deleted") {
      throw new AppError("Domain not found", 404);
    }
    return domain;
  }

  async listDomains(query: QueryDomainDTO): Promise<{ domains: DomainResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) {
      filter.state = query.state;
    }
    if (query.apexDomain) {
      filter.apexDomain = query.apexDomain.toLowerCase().trim();
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) {
        return { domains: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.projectId = project._id;
    }

    const { domains, total } = await this.domainRepository.list(filter, query.page, query.limit);

    const domainDtos = domains.map((domain) => {
      const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
      return toDomainResponseDTO(domain, projectPublicId);
    });

    return {
      domains: domainDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateDomain(publicId: string, dto: UpdateDomainDTO): Promise<DomainResponseDTO> {
    const existing = await this.domainRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Domain not found", 404);
    }

    const updated = await this.domainRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update domain", 500);
    }

    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";
    return toDomainResponseDTO(updated, projectPublicId);
  }

  async deleteDomain(publicId: string): Promise<void> {
    const deleted = await this.domainRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("Domain not found", 404);
    }
  }
}
