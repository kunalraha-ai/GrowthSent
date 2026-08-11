import { Document, Types } from "mongoose";

export interface IOpenGraph {
  title?: string;
  description?: string;
  image?: string;
  type?: string;
}

export interface ITwitterCard {
  card?: string;
  title?: string;
  description?: string;
  image?: string;
}

export interface IHreflang {
  lang: string;
  href: string;
}

export interface IPageMetadata {
  _id: Types.ObjectId;
  publicId: string;
  pageId: Types.ObjectId;
  domainId: Types.ObjectId;
  projectId: Types.ObjectId;
  openGraph?: IOpenGraph;
  twitterCard?: ITwitterCard;
  hreflang: IHreflang[];
  structuredDataTypes: string[];
  jsonLdPayloads: Record<string, unknown>[];
  robotsMeta?: string;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPageMetadataDocument extends IPageMetadata, Document<Types.ObjectId> {}
