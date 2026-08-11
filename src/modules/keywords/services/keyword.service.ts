import { KeywordRepository } from "../repositories/keyword.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CreateKeywordDTO, UpdateKeywordDTO, QueryKeywordDTO } from "../validators/keyword.validator";
import { KeywordResponseDTO, toKeywordResponseDTO } from "../dtos/keyword.dto";
import { AppError } from "../../../shared/errors/appError";
import { IKeywordDocument } from "../interfaces/keyword.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class KeywordService {
  constructor(
    private readonly keywordRepository: KeywordRepository = new KeywordRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async createKeyword(dto: CreateKeywordDTO): Promise<KeywordResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const existing = await this.keywordRepository.findByDomainTermEngine(
      domain._id,
      dto.term,
      dto.searchEngine || "google",
      dto.country || "us",
      dto.device || "desktop"
    );
    if (existing) {
      throw new AppError("Keyword already tracked for this domain, engine, country, and device", 409);
    }

    const newKeyword = await this.keywordRepository.create({
      domainId: domain._id,
      projectId: domain.projectId,
      term: dto.term,
      searchEngine: dto.searchEngine || "google",
      country: dto.country || "us",
      device: dto.device || "desktop",
      searchVolume: dto.searchVolume || 0,
      state: "active",
      schemaVersion: "1.0.0",
      revision: 1,
    });

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toKeywordResponseDTO(newKeyword, domain.publicId, projectPublicId);
  }

  async getKeywordByPublicId(publicId: string): Promise<KeywordResponseDTO> {
    const keyword = await this.keywordRepository.findByPublicId(publicId);
    if (!keyword) {
      throw new AppError("Keyword not found", 404);
    }

    const domainPublicId = (keyword.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (keyword.projectId as unknown as IProjectDocument)?.publicId || "";

    return toKeywordResponseDTO(keyword, domainPublicId, projectPublicId);
  }

  async listKeywords(query: QueryKeywordDTO): Promise<{ keywords: KeywordResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.searchEngine) filter.searchEngine = query.searchEngine;
    if (query.country) filter.country = query.country.toLowerCase().trim();
    if (query.device) filter.device = query.device;
    if (query.state) filter.state = query.state;

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { keywords: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { keywords: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    const { keywords, total } = await this.keywordRepository.list(filter, query.page, query.limit);

    const dtos = keywords.map((k) => {
      const domainPublicId = (k.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (k.projectId as unknown as IProjectDocument)?.publicId || "";
      return toKeywordResponseDTO(k, domainPublicId, projectPublicId);
    });

    return {
      keywords: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateKeyword(publicId: string, dto: UpdateKeywordDTO): Promise<KeywordResponseDTO> {
    const existing = await this.keywordRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Keyword not found", 404);
    }

    const updated = await this.keywordRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update keyword", 500);
    }

    const domainPublicId = (updated.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";

    return toKeywordResponseDTO(updated, domainPublicId, projectPublicId);
  }

  async deleteKeyword(publicId: string): Promise<void> {
    const deleted = await this.keywordRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("Keyword not found", 404);
    }
  }
}
