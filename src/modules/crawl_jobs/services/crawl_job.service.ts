import { CrawlJobRepository } from "../repositories/crawl_job.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { CrawlSourceRepository } from "../../crawl_sources/repositories/crawl_source.repository";
import { CreateCrawlJobDTO, UpdateCrawlJobDTO, QueryCrawlJobDTO } from "../validators/crawl_job.validator";
import { CrawlJobResponseDTO, toCrawlJobResponseDTO } from "../dtos/crawl_job.dto";
import { AppError } from "../../../shared/errors/appError";
import { ICrawlJobDocument } from "../interfaces/crawl_job.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";
import { ICrawlSourceDocument } from "../../crawl_sources/interfaces/crawl_source.interface";

export class CrawlJobService {
  constructor(
    private readonly crawlJobRepository: CrawlJobRepository = new CrawlJobRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly userRepository: UserRepository = new UserRepository(),
    private readonly crawlSourceRepository: CrawlSourceRepository = new CrawlSourceRepository()
  ) {}

  async createCrawlJob(dto: CreateCrawlJobDTO): Promise<CrawlJobResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    let triggeredByUserId = undefined;
    if (dto.triggeredByUserPublicId) {
      const user = await this.userRepository.findByPublicId(dto.triggeredByUserPublicId);
      if (user) triggeredByUserId = user._id;
    }

    let crawlSourceId = undefined;
    if (dto.crawlSourcePublicId) {
      const source = await this.crawlSourceRepository.findByPublicId(dto.crawlSourcePublicId);
      if (source) crawlSourceId = source._id;
    }

    const newJob = await this.crawlJobRepository.create({
      domainId: domain._id,
      projectId: domain.projectId,
      triggeredByUserId,
      crawlSourceId,
      engine: dto.engine || "Internal",
      jobType: dto.jobType || "full_site_audit",
      status: "pending",
      configuration: dto.configuration || { maxDepth: 5, maxPages: 10000 },
      stats: { pagesDiscovered: 0, pagesCrawled: 0, pagesFailed: 0, durationMs: 0 },
      schemaVersion: "1.0.0",
    });

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toCrawlJobResponseDTO(
      newJob,
      domain.publicId,
      projectPublicId,
      dto.triggeredByUserPublicId,
      dto.crawlSourcePublicId
    );
  }

  async getCrawlJobByPublicId(publicId: string): Promise<CrawlJobResponseDTO> {
    const job = await this.crawlJobRepository.findByPublicId(publicId);
    if (!job) {
      throw new AppError("Crawl job not found", 404);
    }

    const domainPublicId = (job.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (job.projectId as unknown as IProjectDocument)?.publicId || "";
    const triggeredByUserPublicId = (job.triggeredByUserId as unknown as IUserDocument)?.publicId;
    const crawlSourcePublicId = (job.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId;

    return toCrawlJobResponseDTO(job, domainPublicId, projectPublicId, triggeredByUserPublicId, crawlSourcePublicId);
  }

  async listCrawlJobs(query: QueryCrawlJobDTO): Promise<{ jobs: CrawlJobResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.engine) filter.engine = query.engine;

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) {
        return { jobs: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) {
        return { jobs: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.projectId = project._id;
    }

    const { jobs, total } = await this.crawlJobRepository.list(filter, query.page, query.limit);

    const jobDtos = jobs.map((job) => {
      const domainPublicId = (job.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (job.projectId as unknown as IProjectDocument)?.publicId || "";
      const triggeredByUserPublicId = (job.triggeredByUserId as unknown as IUserDocument)?.publicId;
      const crawlSourcePublicId = (job.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId;
      return toCrawlJobResponseDTO(job, domainPublicId, projectPublicId, triggeredByUserPublicId, crawlSourcePublicId);
    });

    return {
      jobs: jobDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateCrawlJob(publicId: string, dto: UpdateCrawlJobDTO): Promise<CrawlJobResponseDTO> {
    const existing = await this.crawlJobRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Crawl job not found", 404);
    }

    const updated = await this.crawlJobRepository.updateByPublicId(publicId, dto);
    if (!updated) {
      throw new AppError("Failed to update crawl job", 500);
    }

    const domainPublicId = (updated.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";
    const triggeredByUserPublicId = (updated.triggeredByUserId as unknown as IUserDocument)?.publicId;
    const crawlSourcePublicId = (updated.crawlSourceId as unknown as ICrawlSourceDocument)?.publicId;

    return toCrawlJobResponseDTO(updated, domainPublicId, projectPublicId, triggeredByUserPublicId, crawlSourcePublicId);
  }
}
