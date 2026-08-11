import { BacklinkRepository } from "../repositories/backlink.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { CrawlSourceRepository } from "../../crawl_sources/repositories/crawl_source.repository";
import { CreateBacklinkDTO, UpdateBacklinkDTO, QueryBacklinkDTO, computeSha256, extractDomainFromUrl } from "../validators/backlink.validator";
import { BacklinkResponseDTO, toBacklinkResponseDTO } from "../dtos/backlink.dto";
import { AppError } from "../../../shared/errors/appError";
import { IBacklinkDocument } from "../interfaces/backlink.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { ICrawlSourceDocument } from "../../crawl_sources/interfaces/crawl_source.interface";

export class BacklinkService {
  constructor(
    private readonly backlinkRepository: BacklinkRepository = new BacklinkRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly crawlSourceRepository: CrawlSourceRepository = new CrawlSourceRepository()
  ) {}

  async createBacklink(dto: CreateBacklinkDTO): Promise<BacklinkResponseDTO> {
    const targetDomain = await this.domainRepository.findByPublicId(dto.targetDomainPublicId);
    if (!targetDomain) {
      throw new AppError("Target domain not found", 404);
    }

    const sourceDomain = extractDomainFromUrl(dto.sourceUrl);
    if (!sourceDomain) {
      throw new AppError("Invalid source URL domain", 400);
    }

    const targetUrlHash = computeSha256(dto.targetUrl);
    const sourceUrlHash = computeSha256(dto.sourceUrl);

    const existing = await this.backlinkRepository.findEdgeSignature(targetDomain._id, sourceUrlHash, targetUrlHash, dto.snapshot);
    if (existing) {
      throw new AppError("Backlink edge signature already exists for this snapshot", 409);
    }

    let crawlSourceId = undefined;
    if (dto.crawlSourcePublicId) {
      const source = await this.crawlSourceRepository.findByPublicId(dto.crawlSourcePublicId);
      if (source) crawlSourceId = source._id;
    }

    const newBacklink = await this.backlinkRepository.create({
      targetDomainId: targetDomain._id,
      targetUrl: dto.targetUrl,
      targetUrlHash,
      sourceDomain,
      sourceUrl: dto.sourceUrl,
      sourceUrlHash,
      anchorText: dto.anchorText,
      linkLocation: dto.linkLocation || "content",
      isNoFollow: dto.isNoFollow ?? false,
      isUgc: dto.isUgc ?? false,
      isSponsored: dto.isSponsored ?? false,
      isLost: dto.isLost ?? false,
      snapshot: dto.snapshot,
      discoveredBy: dto.discoveredBy || "Native Crawler",
      crawlSourceId,
      domainAuthority: dto.domainAuthority || 0,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      state: dto.isLost ? "lost" : "active",
      schemaVersion: "1.0.0",
    });

    return toBacklinkResponseDTO(newBacklink, targetDomain.publicId, dto.crawlSourcePublicId);
  }

  async getBacklinkByPublicId(publicId: string): Promise<BacklinkResponseDTO> {
    const backlink = await this.backlinkRepository.findByPublicId(publicId);
    if (!backlink) {
      throw new AppError("Backlink not found", 404);
    }

    const targetDomainPublicId = (backlink.targetDomainId as unknown as IDomainDocument)?.publicId || "";
    const crawlSourcePublicId = (backlink.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId;

    return toBacklinkResponseDTO(backlink, targetDomainPublicId, crawlSourcePublicId);
  }

  async listBacklinks(query: QueryBacklinkDTO): Promise<{ backlinks: BacklinkResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.snapshot) filter.snapshot = query.snapshot;
    if (query.linkLocation) filter.linkLocation = query.linkLocation;
    if (query.isNoFollow !== undefined) filter.isNoFollow = query.isNoFollow;
    if (query.isLost !== undefined) filter.isLost = query.isLost;
    if (query.state) filter.state = query.state;
    if (query.sourceDomain) filter.sourceDomain = query.sourceDomain.toLowerCase().trim();

    if (query.targetDomainPublicId) {
      const targetDomain = await this.domainRepository.findByPublicId(query.targetDomainPublicId);
      if (!targetDomain) return { backlinks: [], total: 0, page: query.page, limit: query.limit };
      filter.targetDomainId = targetDomain._id;
    }

    const { backlinks, total } = await this.backlinkRepository.list(filter, query.page, query.limit);

    const dtos = backlinks.map((b) => {
      const targetDomainPublicId = (b.targetDomainId as unknown as IDomainDocument)?.publicId || "";
      const crawlSourcePublicId = (b.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId;
      return toBacklinkResponseDTO(b, targetDomainPublicId, crawlSourcePublicId);
    });

    return {
      backlinks: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateBacklink(publicId: string, dto: UpdateBacklinkDTO): Promise<BacklinkResponseDTO> {
    const existing = await this.backlinkRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Backlink not found", 404);
    }

    const updated = await this.backlinkRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update backlink", 500);
    }

    const targetDomainPublicId = (updated.targetDomainId as unknown as IDomainDocument)?.publicId || "";
    const crawlSourcePublicId = (updated.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId;

    return toBacklinkResponseDTO(updated, targetDomainPublicId, crawlSourcePublicId);
  }

  async deleteBacklink(publicId: string): Promise<void> {
    const deleted = await this.backlinkRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("Backlink not found", 404);
    }
  }
}
