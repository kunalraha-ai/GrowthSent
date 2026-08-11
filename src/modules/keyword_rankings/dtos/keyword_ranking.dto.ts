import { IKeywordRanking } from "../interfaces/keyword_ranking.interface";
import { SearchEngineType } from "../../keywords/interfaces/keyword.interface";

export interface KeywordRankingResponseDTO {
  publicId: string;
  keywordPublicId: string;
  domainPublicId: string;
  projectPublicId: string;
  rankingUrl: string;
  searchEngine: SearchEngineType;
  position: number;
  previousPosition?: number;
  snapshot: string;
  crawlJobPublicId?: string;
  schemaVersion: string;
  createdAt: Date;
}

export function toKeywordRankingResponseDTO(
  ranking: IKeywordRanking,
  keywordPublicId: string,
  domainPublicId: string,
  projectPublicId: string,
  crawlJobPublicId?: string
): KeywordRankingResponseDTO {
  return {
    publicId: ranking.publicId,
    keywordPublicId,
    domainPublicId,
    projectPublicId,
    rankingUrl: ranking.rankingUrl,
    searchEngine: ranking.searchEngine,
    position: ranking.position,
    previousPosition: ranking.previousPosition,
    snapshot: ranking.snapshot,
    crawlJobPublicId,
    schemaVersion: ranking.schemaVersion,
    createdAt: ranking.createdAt,
  };
}
