import { PageRepository } from "../repositories/page.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CreatePageDTO, UpdatePageDTO, QueryPageDTO, computeSha256, extractPathFromUrl } from "../validators/page.validator";
import { PageResponseDTO, toPageResponseDTO } from "../dtos/page.dto";
import { AppError } from "../../../shared/errors/appError";
import { IPageDocument } from "../interfaces/page.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class PageService {
  constructor(
    private readonly pageRepository: PageRepository = new PageRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async createPage(dto: CreatePageDTO): Promise<PageResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const urlHash = computeSha256(dto.url);
    const existingPage = await this.pageRepository.findByUrlHash(domain._id, urlHash);
    if (existingPage) {
      throw new AppError("Page with this URL already exists in this domain", 409);
    }

    const path = extractPathFromUrl(dto.url);
    const contentHash = dto.contentHtml ? computeSha256(dto.contentHtml) : undefined;
    const titleHash = dto.title ? computeSha256(dto.title) : undefined;

    const newPage = await this.pageRepository.create({
      domainId: domain._id,
      projectId: domain.projectId,
      url: dto.url,
      urlHash,
      contentHash,
      titleHash,
      path,
      statusCode: dto.statusCode || 200,
      title: dto.title,
      metaDescription: dto.metaDescription,
      canonicalUrl: dto.canonicalUrl,
      isIndexable: dto.isIndexable ?? true,
      wordCount: dto.wordCount || 0,
      loadTimeMs: dto.loadTimeMs || 0,
      discoverySource: dto.discoverySource || "crawl",
      lastCrawledAt: new Date(),
      state: "active",
      schemaVersion: "1.0.0",
      revision: 1,
    });

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toPageResponseDTO(newPage, domain.publicId, projectPublicId);
  }

  async getPageByPublicId(publicId: string): Promise<PageResponseDTO> {
    const page = await this.pageRepository.findByPublicId(publicId);
    if (!page) {
      throw new AppError("Page not found", 404);
    }

    const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageResponseDTO(page, domainPublicId, projectPublicId);
  }

  async listPages(query: QueryPageDTO): Promise<{ pages: PageResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) filter.state = query.state;
    if (query.statusCode !== undefined) filter.statusCode = query.statusCode;
    if (query.isIndexable !== undefined) filter.isIndexable = query.isIndexable;
    if (query.discoverySource) filter.discoverySource = query.discoverySource;

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) {
        return { pages: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) {
        return { pages: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.projectId = project._id;
    }

    const { pages, total } = await this.pageRepository.list(filter, query.page, query.limit);

    const pageDtos = pages.map((page) => {
      const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";
      return toPageResponseDTO(page, domainPublicId, projectPublicId);
    });

    return {
      pages: pageDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updatePage(publicId: string, dto: UpdatePageDTO): Promise<PageResponseDTO> {
    const existing = await this.pageRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Page not found", 404);
    }

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.title) {
      updateData.titleHash = computeSha256(dto.title);
    }

    const updated = await this.pageRepository.updateByPublicId(publicId, updateData);
    if (!updated) {
      throw new AppError("Failed to update page", 500);
    }

    const domainPublicId = (updated.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageResponseDTO(updated, domainPublicId, projectPublicId);
  }

  async deletePage(publicId: string): Promise<void> {
    const deleted = await this.pageRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("Page not found", 404);
    }
  }
}
