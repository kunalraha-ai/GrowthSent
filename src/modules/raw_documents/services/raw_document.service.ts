import { RawDocumentRepository } from "../repositories/raw_document.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { PageRepository } from "../../pages/repositories/page.repository";
import { CrawlSourceRepository } from "../../crawl_sources/repositories/crawl_source.repository";
import { CreateRawDocumentDTO, QueryRawDocumentDTO } from "../validators/raw_document.validator";
import { RawDocumentResponseDTO, toRawDocumentResponseDTO } from "../dtos/raw_document.dto";
import { AppError } from "../../../shared/errors/appError";
import { IRawDocumentDocument } from "../interfaces/raw_document.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IPageDocument } from "../../pages/interfaces/page.interface";
import { ICrawlSourceDocument } from "../../crawl_sources/interfaces/crawl_source.interface";

export class RawDocumentService {
  constructor(
    private readonly rawDocumentRepository: RawDocumentRepository = new RawDocumentRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly pageRepository: PageRepository = new PageRepository(),
    private readonly crawlSourceRepository: CrawlSourceRepository = new CrawlSourceRepository()
  ) {}

  async createRawDocument(dto: CreateRawDocumentDTO): Promise<RawDocumentResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const crawlSource = await this.crawlSourceRepository.findByPublicId(dto.crawlSourcePublicId);
    if (!crawlSource) {
      throw new AppError("Crawl source not found", 404);
    }

    const existingChecksum = await this.rawDocumentRepository.findByChecksum(dto.storage.checksum);
    if (existingChecksum) {
      throw new AppError("Document with this payload checksum already exists", 409);
    }

    let pageId = undefined;
    if (dto.pagePublicId) {
      const page = await this.pageRepository.findByPublicId(dto.pagePublicId);
      if (page) pageId = page._id;
    }

    const newDoc = await this.rawDocumentRepository.create({
      domainId: domain._id,
      pageId,
      crawlSourceId: crawlSource._id,
      storage: dto.storage,
      crawl: dto.crawl,
      schemaVersion: "1.0.0",
    });

    return toRawDocumentResponseDTO(newDoc, domain.publicId, crawlSource.publicId, dto.pagePublicId);
  }

  async getRawDocumentByPublicId(publicId: string): Promise<RawDocumentResponseDTO> {
    const doc = await this.rawDocumentRepository.findByPublicId(publicId);
    if (!doc) {
      throw new AppError("Raw document not found", 404);
    }

    const domainPublicId = (doc.domainId as unknown as IDomainDocument)?.publicId || "";
    const pagePublicId = (doc.pageId as unknown as IPageDocument)?.publicId;
    const crawlSourcePublicId = (doc.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId || "";

    return toRawDocumentResponseDTO(doc, domainPublicId, crawlSourcePublicId, pagePublicId);
  }

  async listRawDocuments(query: QueryRawDocumentDTO): Promise<{ documents: RawDocumentResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.crawl) filter.crawl = query.crawl;
    if (query.checksum) filter["storage.checksum"] = query.checksum;

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { documents: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.pagePublicId) {
      const page = await this.pageRepository.findByPublicId(query.pagePublicId);
      if (!page) return { documents: [], total: 0, page: query.page, limit: query.limit };
      filter.pageId = page._id;
    }

    if (query.crawlSourcePublicId) {
      const source = await this.crawlSourceRepository.findByPublicId(query.crawlSourcePublicId);
      if (!source) return { documents: [], total: 0, page: query.page, limit: query.limit };
      filter.crawlSourceId = source._id;
    }

    const { documents, total } = await this.rawDocumentRepository.list(filter, query.page, query.limit);

    const dtos = documents.map((doc) => {
      const domainPublicId = (doc.domainId as unknown as IDomainDocument)?.publicId || "";
      const pagePublicId = (doc.pageId as unknown as IPageDocument)?.publicId;
      const crawlSourcePublicId = (doc.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId || "";
      return toRawDocumentResponseDTO(doc, domainPublicId, crawlSourcePublicId, pagePublicId);
    });

    return {
      documents: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
