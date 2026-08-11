import {
  IBacklink,
  LinkLocationType,
  DiscoveredByType,
  BacklinkState,
} from "../interfaces/backlink.interface";

export interface BacklinkResponseDTO {
  publicId: string;
  targetDomainPublicId: string;
  targetUrl: string;
  targetUrlHash: string;
  sourceDomain: string;
  sourceUrl: string;
  sourceUrlHash: string;
  anchorText?: string;
  linkLocation: LinkLocationType;
  isNoFollow: boolean;
  isUgc: boolean;
  isSponsored: boolean;
  isLost: boolean;
  snapshot: string;
  discoveredBy: DiscoveredByType;
  crawlSourcePublicId?: string;
  domainAuthority: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  state: BacklinkState;
  createdAt: Date;
}

export function toBacklinkResponseDTO(
  backlink: IBacklink,
  targetDomainPublicId: string,
  crawlSourcePublicId?: string
): BacklinkResponseDTO {
  return {
    publicId: backlink.publicId,
    targetDomainPublicId,
    targetUrl: backlink.targetUrl,
    targetUrlHash: backlink.targetUrlHash,
    sourceDomain: backlink.sourceDomain,
    sourceUrl: backlink.sourceUrl,
    sourceUrlHash: backlink.sourceUrlHash,
    anchorText: backlink.anchorText,
    linkLocation: backlink.linkLocation,
    isNoFollow: backlink.isNoFollow,
    isUgc: backlink.isUgc,
    isSponsored: backlink.isSponsored,
    isLost: backlink.isLost,
    snapshot: backlink.snapshot,
    discoveredBy: backlink.discoveredBy,
    crawlSourcePublicId,
    domainAuthority: backlink.domainAuthority,
    firstSeenAt: backlink.firstSeenAt,
    lastSeenAt: backlink.lastSeenAt,
    state: backlink.state,
    createdAt: backlink.createdAt,
  };
}
