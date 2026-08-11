import { PageMetadataRepository } from "../repositories/page_metadata.repository";
import { PageRepository } from "../../pages/repositories/page.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { UpsertPageMetadataDTO, QueryPageMetadataDTO } from "../validators/page_metadata.validator";
import { PageMetadataResponseDTO, toPageMetadataResponseDTO } from "../dtos/page_metadata.dto";
import { AppError } from "../../../shared/errors/appError";
import { IPageMetadataDocument } from "../interfaces/page_metadata.interface";
import { IPageDocument } from "../../pages/interfaces/page.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class PageMetadataService {
  constructor(
    private readonly pageMetadataRepository: PageMetadataRepository = new PageMetadataRepository(),
    private readonly pageRepository: PageRepository = new PageRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository()
  ) {}

  async upsertPageMetadata(dto: UpsertPageMetadataDTO): Promise<PageMetadataResponseDTO> {
    const page = await this.pageRepository.findByPublicId(dto.pagePublicId);
    if (!page) {
      throw new AppError("Page not found", 404);
    }

    const updated = await this.pageMetadataRepository.upsertByPageId(page._id, {
      domainId: page.domainId,
      projectId: page.projectId,
      openGraph: dto.openGraph,
      twitterCard: dto.twitterCard,
      hreflang: dto.hreflang || [],
      structuredDataTypes: dto.structuredDataTypes || [],
      jsonLdPayloads: dto.jsonLdPayloads || [],
      robotsMeta: dto.robotsMeta,
      schemaVersion: "1.0.0",
    });

    const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageMetadataResponseDTO(updated, page.publicId, domainPublicId, projectPublicId);
  }

  async getMetadataByPagePublicId(pagePublicId: string): Promise<PageMetadataResponseDTO> {
    const page = await this.pageRepository.findByPublicId(pagePublicId);
    if (!page) {
      throw new AppError("Page not found", 404);
    }

    const metadata = await this.pageMetadataRepository.findByPageId(page._id);
    if (!metadata) {
      throw new AppError("Metadata not found for this page", 404);
    }

    const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageMetadataResponseDTO(metadata, page.publicId, domainPublicId, projectPublicId);
  }

  async listMetadata(query: QueryPageMetadataDTO): Promise<{ metadataList: PageMetadataResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) {
        return { metadataList: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.domainId = domain._id;
    }

    if (query.pagePublicId) {
      const page = await this.pageRepository.findByPublicId(query.pagePublicId);
      if (!page) {
        return { metadataList: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.pageId = page._id;
    }

    const { metadataList, total } = await this.pageMetadataRepository.list(filter, query.page, query.limit);

    const dtos = metadataList.map((item) => {
      const pagePublicId = (item.pageId as unknown as IPageDocument)?.publicId || "";
      const domainPublicId = (item.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (item.projectId as unknown as IProjectDocument)?.publicId || "";
      return toPageMetadataResponseDTO(item, pagePublicId, domainPublicId, projectPublicId);
    });

    return {
      metadataList: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
