import { CrawlSnapshotRepository } from "../repositories/crawl_snapshot.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CrawlJobRepository } from "../../crawl_jobs/repositories/crawl_job.repository";
import { CreateCrawlSnapshotDTO, QueryCrawlSnapshotDTO } from "../validators/crawl_snapshot.validator";
import { CrawlSnapshotResponseDTO, toCrawlSnapshotResponseDTO } from "../dtos/crawl_snapshot.dto";
import { AppError } from "../../../shared/errors/appError";
import { ICrawlSnapshotDocument } from "../interfaces/crawl_snapshot.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { ICrawlJobDocument } from "../../crawl_jobs/interfaces/crawl_job.interface";

export class CrawlSnapshotService {
  constructor(
    private readonly crawlSnapshotRepository: CrawlSnapshotRepository = new CrawlSnapshotRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly crawlJobRepository: CrawlJobRepository = new CrawlJobRepository()
  ) {}

  async createCrawlSnapshot(dto: CreateCrawlSnapshotDTO): Promise<CrawlSnapshotResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const crawlJob = await this.crawlJobRepository.findByPublicId(dto.crawlJobPublicId);
    if (!crawlJob) {
      throw new AppError("Crawl job not found", 404);
    }

    const existing = await this.crawlSnapshotRepository.findByDomainAndSnapshotTag(domain._id, dto.snapshot);
    if (existing) {
      throw new AppError("Snapshot tag already exists for this domain", 409);
    }

    const newSnapshot = await this.crawlSnapshotRepository.create({
      domainId: domain._id,
      projectId: domain.projectId,
      crawlJobId: crawlJob._id,
      snapshot: dto.snapshot,
      resolvedIps: dto.resolvedIps || [],
      pagesCount: dto.pagesCount || 0,
      backlinksCount: dto.backlinksCount || 0,
      healthScore: dto.healthScore ?? 100,
      issuesBreakdown: dto.issuesBreakdown || { critical: 0, warning: 0, info: 0 },
      durationMs: dto.durationMs || 0,
      schemaVersion: "1.0.0",
    });

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toCrawlSnapshotResponseDTO(newSnapshot, domain.publicId, projectPublicId, crawlJob.publicId);
  }

  async getCrawlSnapshotByPublicId(publicId: string): Promise<CrawlSnapshotResponseDTO> {
    const snapshot = await this.crawlSnapshotRepository.findByPublicId(publicId);
    if (!snapshot) {
      throw new AppError("Crawl snapshot not found", 404);
    }

    const domainPublicId = (snapshot.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (snapshot.projectId as unknown as IProjectDocument)?.publicId || "";
    const crawlJobPublicId = (snapshot.crawlJobId as unknown as ICrawlJobDocument)?.publicId || "";

    return toCrawlSnapshotResponseDTO(snapshot, domainPublicId, projectPublicId, crawlJobPublicId);
  }

  async listCrawlSnapshots(query: QueryCrawlSnapshotDTO): Promise<{ snapshots: CrawlSnapshotResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.snapshot) filter.snapshot = query.snapshot;

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) {
        return { snapshots: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) {
        return { snapshots: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.projectId = project._id;
    }

    const { snapshots, total } = await this.crawlSnapshotRepository.list(filter, query.page, query.limit);

    const snapshotDtos = snapshots.map((snapshot) => {
      const domainPublicId = (snapshot.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (snapshot.projectId as unknown as IProjectDocument)?.publicId || "";
      const crawlJobPublicId = (snapshot.crawlJobId as unknown as ICrawlJobDocument)?.publicId || "";
      return toCrawlSnapshotResponseDTO(snapshot, domainPublicId, projectPublicId, crawlJobPublicId);
    });

    return {
      snapshots: snapshotDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
