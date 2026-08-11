import { CrawlSourceRepository } from "../repositories/crawl_source.repository";
import { CreateCrawlSourceDTO, UpdateCrawlSourceDTO, QueryCrawlSourceDTO } from "../validators/crawl_source.validator";
import { CrawlSourceResponseDTO, toCrawlSourceResponseDTO } from "../dtos/crawl_source.dto";
import { AppError } from "../../../shared/errors/appError";
import { ICrawlSourceDocument } from "../interfaces/crawl_source.interface";

export class CrawlSourceService {
  constructor(private readonly crawlSourceRepository: CrawlSourceRepository = new CrawlSourceRepository()) {}

  async createCrawlSource(dto: CreateCrawlSourceDTO): Promise<CrawlSourceResponseDTO> {
    const newSource = await this.crawlSourceRepository.create({
      name: dto.name,
      type: dto.type,
      provider: dto.provider,
      description: dto.description,
      isActive: dto.isActive ?? true,
      schemaVersion: "1.0.0",
    });

    return toCrawlSourceResponseDTO(newSource);
  }

  async getCrawlSourceByPublicId(publicId: string): Promise<CrawlSourceResponseDTO> {
    const source = await this.crawlSourceRepository.findByPublicId(publicId);
    if (!source) {
      throw new AppError("Crawl source not found", 404);
    }
    return toCrawlSourceResponseDTO(source);
  }

  async getCrawlSourceByObjectId(objectId: string): Promise<ICrawlSourceDocument> {
    const source = await this.crawlSourceRepository.findByPublicId(objectId);
    if (!source) {
      throw new AppError("Crawl source not found", 404);
    }
    return source;
  }

  async listCrawlSources(query: QueryCrawlSourceDTO): Promise<{ sources: CrawlSourceResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.provider) filter.provider = query.provider;
    if (query.type) filter.type = query.type;
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    const { sources, total } = await this.crawlSourceRepository.list(filter, query.page, query.limit);

    return {
      sources: sources.map(toCrawlSourceResponseDTO),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateCrawlSource(publicId: string, dto: UpdateCrawlSourceDTO): Promise<CrawlSourceResponseDTO> {
    const existing = await this.crawlSourceRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Crawl source not found", 404);
    }

    const updated = await this.crawlSourceRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update crawl source", 500);
    }

    return toCrawlSourceResponseDTO(updated);
  }
}
