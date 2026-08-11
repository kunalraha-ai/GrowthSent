import { CacheStatRepository } from "../repositories/cache_stat.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { UpsertCacheStatDTO, QueryCacheStatDTO } from "../validators/cache_stat.validator";
import { CacheStatResponseDTO, toCacheStatResponseDTO } from "../dtos/cache_stat.dto";
import { AppError } from "../../../shared/errors/appError";
import { ICacheStatDocument } from "../interfaces/cache_stat.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class CacheStatService {
  constructor(
    private readonly cacheStatRepository: CacheStatRepository = new CacheStatRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async upsertCacheStat(dto: UpsertCacheStatDTO): Promise<CacheStatResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(dto.domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const expiresAt = new Date(Date.now() + dto.ttlSeconds * 1000);

    const updated = await this.cacheStatRepository.upsertByDomainAndKey(
      domain._id,
      domain.projectId,
      dto.key,
      dto.payload,
      expiresAt
    );

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toCacheStatResponseDTO(updated, domain.publicId, projectPublicId);
  }

  async getCacheStat(domainPublicId: string, key: string): Promise<CacheStatResponseDTO> {
    const domain = await this.domainRepository.findByPublicId(domainPublicId);
    if (!domain) {
      throw new AppError("Domain not found", 404);
    }

    const stat = await this.cacheStatRepository.findByDomainAndKey(domain._id, key);
    if (!stat) {
      throw new AppError("Cache key not found or expired", 404);
    }

    const projectPublicId = (domain.projectId as unknown as IProjectDocument)?.publicId || "";
    return toCacheStatResponseDTO(stat, domain.publicId, projectPublicId);
  }
}
