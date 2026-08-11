import { PageAuditRepository } from "../repositories/page_audit.repository";
import { PageRepository } from "../../pages/repositories/page.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CrawlJobRepository } from "../../crawl_jobs/repositories/crawl_job.repository";
import { CreatePageAuditDTO, QueryPageAuditDTO } from "../validators/page_audit.validator";
import { PageAuditResponseDTO, toPageAuditResponseDTO } from "../dtos/page_audit.dto";
import { AppError } from "../../../shared/errors/appError";
import { IPageAuditDocument } from "../interfaces/page_audit.interface";
import { IPageDocument } from "../../pages/interfaces/page.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { ICrawlJobDocument } from "../../crawl_jobs/interfaces/crawl_job.interface";

export class PageAuditService {
  constructor(
    private readonly pageAuditRepository: PageAuditRepository = new PageAuditRepository(),
    private readonly pageRepository: PageRepository = new PageRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly crawlJobRepository: CrawlJobRepository = new CrawlJobRepository()
  ) {}

  async createPageAudit(dto: CreatePageAuditDTO): Promise<PageAuditResponseDTO> {
    const page = await this.pageRepository.findByPublicId(dto.pagePublicId);
    if (!page) {
      throw new AppError("Page not found", 404);
    }

    const crawlJob = await this.crawlJobRepository.findByPublicId(dto.crawlJobPublicId);
    if (!crawlJob) {
      throw new AppError("Crawl job not found", 404);
    }

    const algorithmVersion = dto.algorithmVersion || "1.0.0";
    const existing = await this.pageAuditRepository.findByPageCrawlAndAlgorithm(page._id, crawlJob._id, algorithmVersion);
    if (existing) {
      throw new AppError("Audit execution already recorded for this page, job, and algorithm version", 409);
    }

    const auditDate = new Date().toISOString().split("T")[0];

    const newAudit = await this.pageAuditRepository.create({
      pageId: page._id,
      domainId: page.domainId,
      projectId: page.projectId,
      crawlJobId: crawlJob._id,
      snapshot: dto.snapshot,
      auditDate,
      algorithmVersion,
      engineMetadata: dto.engineMetadata || { engine: "GrowthSent Core Auditor", ruleset: "technical_v3" },
      seoScore: dto.seoScore ?? 100,
      issuesSummary: dto.issuesSummary || { critical: 0, warning: 0, info: 0 },
      schemaVersion: "1.0.0",
    });

    const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageAuditResponseDTO(newAudit, page.publicId, domainPublicId, projectPublicId, crawlJob.publicId);
  }

  async getPageAuditByPublicId(publicId: string): Promise<PageAuditResponseDTO> {
    const audit = await this.pageAuditRepository.findByPublicId(publicId);
    if (!audit) {
      throw new AppError("Page audit not found", 404);
    }

    const pagePublicId = (audit.pageId as unknown as IPageDocument)?.publicId || "";
    const domainPublicId = (audit.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (audit.projectId as unknown as IProjectDocument)?.publicId || "";
    const crawlJobPublicId = (audit.crawlJobId as unknown as ICrawlJobDocument)?.publicId || "";

    return toPageAuditResponseDTO(audit, pagePublicId, domainPublicId, projectPublicId, crawlJobPublicId);
  }

  async listPageAudits(query: QueryPageAuditDTO): Promise<{ audits: PageAuditResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.algorithmVersion) filter.algorithmVersion = query.algorithmVersion;
    if (query.auditDate) filter.auditDate = query.auditDate;

    if (query.pagePublicId) {
      const page = await this.pageRepository.findByPublicId(query.pagePublicId);
      if (!page) return { audits: [], total: 0, page: query.page, limit: query.limit };
      filter.pageId = page._id;
    }

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { audits: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { audits: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    if (query.crawlJobPublicId) {
      const job = await this.crawlJobRepository.findByPublicId(query.crawlJobPublicId);
      if (!job) return { audits: [], total: 0, page: query.page, limit: query.limit };
      filter.crawlJobId = job._id;
    }

    const { audits, total } = await this.pageAuditRepository.list(filter, query.page, query.limit);

    const dtos = audits.map((audit) => {
      const pagePublicId = (audit.pageId as unknown as IPageDocument)?.publicId || "";
      const domainPublicId = (audit.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (audit.projectId as unknown as IProjectDocument)?.publicId || "";
      const crawlJobPublicId = (audit.crawlJobId as unknown as ICrawlJobDocument)?.publicId || "";
      return toPageAuditResponseDTO(audit, pagePublicId, domainPublicId, projectPublicId, crawlJobPublicId);
    });

    return {
      audits: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
