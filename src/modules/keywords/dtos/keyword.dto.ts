import { IKeyword, SearchEngineType, DeviceType, KeywordState } from "../interfaces/keyword.interface";

export interface KeywordResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
  term: string;
  searchEngine: SearchEngineType;
  country: string;
  device: DeviceType;
  searchVolume: number;
  state: KeywordState;
  revision: number;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toKeywordResponseDTO(keyword: IKeyword, domainPublicId: string, projectPublicId: string): KeywordResponseDTO {
  return {
    publicId: keyword.publicId,
    domainPublicId,
    projectPublicId,
    term: keyword.term,
    searchEngine: keyword.searchEngine,
    country: keyword.country,
    device: keyword.device,
    searchVolume: keyword.searchVolume,
    state: keyword.state,
    revision: keyword.revision,
    schemaVersion: keyword.schemaVersion,
    createdAt: keyword.createdAt,
    updatedAt: keyword.updatedAt,
  };
}
