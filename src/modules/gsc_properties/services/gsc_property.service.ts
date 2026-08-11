import { GscPropertyRepository } from "../repositories/gsc_property.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CreateGscPropertyDTO, UpdateGscPropertyDTO, QueryGscPropertyDTO } from "../validators/gsc_property.validator";
import { GscPropertyResponseDTO, toGscPropertyResponseDTO } from "../dtos/gsc_property.dto";
import { AppError } from "../../../shared/errors/appError";
import { IGscPropertyDocument } from "../interfaces/gsc_property.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class GscPropertyService {
  constructor(
    private readonly gscPropertyRepository: GscPropertyRepository = new GscPropertyRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async createGscProperty(dto: CreateGscPropertyDTO): Promise<GscPropertyResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const existing = await this.gscPropertyRepository.findByDomainAndSiteUrl(domain._id, dto.siteUrl);
    if (existing) {
      throw new AppError("GSC Property already linked to this domain", 409);
    }

    const newProp = await this.gscPropertyRepository.create({
      domainId: domain._id,
      projectId: domain.projectId,
      siteUrl: dto.siteUrl,
      permissionLevel: dto.permissionLevel || "siteOwner",
      encryptedCredentials: dto.encryptedCredentials,
      state: "active",
      schemaVersion: "1.0.0",
    });

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toGscPropertyResponseDTO(newProp, domain.publicId, projectPublicId);
  }

  async getGscPropertyByPublicId(publicId: string): Promise<GscPropertyResponseDTO> {
    const prop = await this.gscPropertyRepository.findByPublicId(publicId);
    if (!prop) {
      throw new AppError("GSC property integration not found", 404);
    }

    const domainPublicId = (prop.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (prop.projectId as unknown as IProjectDocument)?.publicId || "";

    return toGscPropertyResponseDTO(prop, domainPublicId, projectPublicId);
  }

  async listGscProperties(query: QueryGscPropertyDTO): Promise<{ properties: GscPropertyResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) filter.state = query.state;

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { properties: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { properties: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    const { properties, total } = await this.gscPropertyRepository.list(filter, query.page, query.limit);

    const dtos = properties.map((prop) => {
      const domainPublicId = (prop.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (prop.projectId as unknown as IProjectDocument)?.publicId || "";
      return toGscPropertyResponseDTO(prop, domainPublicId, projectPublicId);
    });

    return {
      properties: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateGscProperty(publicId: string, dto: UpdateGscPropertyDTO): Promise<GscPropertyResponseDTO> {
    const existing = await this.gscPropertyRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("GSC property integration not found", 404);
    }

    const updated = await this.gscPropertyRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update GSC property integration", 500);
    }

    const domainPublicId = (updated.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";

    return toGscPropertyResponseDTO(updated, domainPublicId, projectPublicId);
  }
}
