import { Ga4PropertyRepository } from "../repositories/ga4_property.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CreateGa4PropertyDTO, UpdateGa4PropertyDTO, QueryGa4PropertyDTO } from "../validators/ga4_property.validator";
import { Ga4PropertyResponseDTO, toGa4PropertyResponseDTO } from "../dtos/ga4_property.dto";
import { AppError } from "../../../shared/errors/appError";
import { IGa4PropertyDocument } from "../interfaces/ga4_property.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class Ga4PropertyService {
  constructor(
    private readonly ga4PropertyRepository: Ga4PropertyRepository = new Ga4PropertyRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async createGa4Property(dto: CreateGa4PropertyDTO): Promise<Ga4PropertyResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const existing = await this.ga4PropertyRepository.findByDomainAndPropertyId(domain._id, dto.propertyId);
    if (existing) {
      throw new AppError("GA4 Property already linked to this domain", 409);
    }

    const newProp = await this.ga4PropertyRepository.create({
      domainId: domain._id,
      projectId: domain.projectId,
      propertyId: dto.propertyId,
      measurementId: dto.measurementId,
      encryptedCredentials: dto.encryptedCredentials,
      state: "active",
      schemaVersion: "1.0.0",
    });

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toGa4PropertyResponseDTO(newProp, domain.publicId, projectPublicId);
  }

  async getGa4PropertyByPublicId(publicId: string): Promise<Ga4PropertyResponseDTO> {
    const prop = await this.ga4PropertyRepository.findByPublicId(publicId);
    if (!prop) {
      throw new AppError("GA4 property integration not found", 404);
    }

    const domainPublicId = (prop.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (prop.projectId as unknown as IProjectDocument)?.publicId || "";

    return toGa4PropertyResponseDTO(prop, domainPublicId, projectPublicId);
  }

  async listGa4Properties(query: QueryGa4PropertyDTO): Promise<{ properties: Ga4PropertyResponseDTO[]; total: number; page: number; limit: number }> {
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

    const { properties, total } = await this.ga4PropertyRepository.list(filter, query.page, query.limit);

    const dtos = properties.map((prop) => {
      const domainPublicId = (prop.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (prop.projectId as unknown as IProjectDocument)?.publicId || "";
      return toGa4PropertyResponseDTO(prop, domainPublicId, projectPublicId);
    });

    return {
      properties: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateGa4Property(publicId: string, dto: UpdateGa4PropertyDTO): Promise<Ga4PropertyResponseDTO> {
    const existing = await this.ga4PropertyRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("GA4 property integration not found", 404);
    }

    const updated = await this.ga4PropertyRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update GA4 property integration", 500);
    }

    const domainPublicId = (updated.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";

    return toGa4PropertyResponseDTO(updated, domainPublicId, projectPublicId);
  }
}
