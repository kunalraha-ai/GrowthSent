import { KeywordRankingRepository } from "../repositories/keyword_ranking.repository";
import { KeywordRepository } from "../../keywords/repositories/keyword.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CrawlJobRepository } from "../../crawl_jobs/repositories/crawl_job.repository";
import { CreateKeywordRankingDTO, QueryKeywordRankingDTO } from "../validators/keyword_ranking.validator";
import { KeywordRankingResponseDTO, toKeywordRankingResponseDTO } from "../dtos/keyword_ranking.dto";
import { AppError } from "../../../shared/errors/appError";
import { IKeywordRankingDocument } from "../interfaces/keyword_ranking.interface";
import { IKeywordDocument } from "../../keywords/interfaces/keyword.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { ICrawlJobDocument } from "../../crawl_jobs/interfaces/crawl_job.interface";

export class KeywordRankingService {
  constructor(
    private readonly keywordRankingRepository: KeywordRankingRepository = new KeywordRankingRepository(),
    private readonly keywordRepository: KeywordRepository = new KeywordRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly crawlJobRepository: CrawlJobRepository = new CrawlJobRepository()
  ) {}

  async createKeywordRanking(dto: CreateKeywordRankingDTO): Promise<KeywordRankingResponseDTO> {
    const keyword = await this.keywordRepository.findByPublicId(dto.keywordPublicId);
    if (!keyword) {
      throw new AppError("Keyword not found", 404);
    }

    const existing = await this.keywordRankingRepository.findByKeywordAndSnapshot(keyword._id, dto.snapshot);
    if (existing) {
      throw new AppError("Ranking observation already recorded for this keyword and snapshot", 409);
    }

    let previousPosition = dto.previousPosition;
    if (previousPosition === undefined) {
      const latest = await this.keywordRankingRepository.findLatestByKeyword(keyword._id);
      if (latest) {
        previousPosition = latest.position;
      }
    }

    let crawlJobId = undefined;
    if (dto.crawlJobPublicId) {
      const job = await this.crawlJobRepository.findByPublicId(dto.crawlJobPublicId);
      if (job) crawlJobId = job._id;
    }

    const newRanking = await this.keywordRankingRepository.create({
      keywordId: keyword._id,
      domainId: keyword.domainId,
      projectId: keyword.projectId,
      rankingUrl: dto.rankingUrl,
      searchEngine: keyword.searchEngine,
      position: dto.position,
      previousPosition,
      snapshot: dto.snapshot,
      crawlJobId,
      schemaVersion: "1.0.0",
    });

    const domainPublicId = (keyword.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (keyword.projectId as unknown as IProjectDocument)?.publicId || "";

    return toKeywordRankingResponseDTO(
      newRanking,
      keyword.publicId,
      domainPublicId,
      projectPublicId,
      dto.crawlJobPublicId
    );
  }

  async getKeywordRankingByPublicId(publicId: string): Promise<KeywordRankingResponseDTO> {
    const ranking = await this.keywordRankingRepository.findByPublicId(publicId);
    if (!ranking) {
      throw new AppError("Keyword ranking observation not found", 404);
    }

    const keywordPublicId = (ranking.keywordId as unknown as IKeywordDocument)?.publicId || "";
    const domainPublicId = (ranking.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (ranking.projectId as unknown as IProjectDocument)?.publicId || "";
    const crawlJobPublicId = (ranking.crawlJobId as unknown as ICrawlJobDocument)?.publicId;

    return toKeywordRankingResponseDTO(ranking, keywordPublicId, domainPublicId, projectPublicId, crawlJobPublicId);
  }

  async listKeywordRankings(query: QueryKeywordRankingDTO): Promise<{ rankings: KeywordRankingResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.searchEngine) filter.searchEngine = query.searchEngine;
    if (query.snapshot) filter.snapshot = query.snapshot;

    if (query.keywordPublicId) {
      const keyword = await this.keywordRepository.findByPublicId(query.keywordPublicId);
      if (!keyword) return { rankings: [], total: 0, page: query.page, limit: query.limit };
      filter.keywordId = keyword._id;
    }

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { rankings: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { rankings: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    const { rankings, total } = await this.keywordRankingRepository.list(filter, query.page, query.limit);

    const rDtos = rankings.map((r) => {
      const keywordPublicId = (r.keywordId as unknown as IKeywordDocument)?.publicId || "";
      const domainPublicId = (r.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (r.projectId as unknown as IProjectDocument)?.publicId || "";
      const crawlJobPublicId = (r.crawlJobId as unknown as ICrawlJobDocument)?.publicId;
      return toKeywordRankingResponseDTO(r, keywordPublicId, domainPublicId, projectPublicId, crawlJobPublicId);
    });

    return {
      rankings: rDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
