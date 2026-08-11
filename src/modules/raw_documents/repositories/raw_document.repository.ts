import { RawDocumentModel } from "../models/raw_document.model";
import { IRawDocument, IRawDocumentDocument } from "../interfaces/raw_document.interface";

export class RawDocumentRepository {
  async create(docData: Partial<IRawDocument>): Promise<IRawDocumentDocument> {
    const doc = new RawDocumentModel(docData);
    return await doc.save();
  }

  async findByPublicId(publicId: string): Promise<IRawDocumentDocument | null> {
    return await RawDocumentModel.findOne({ publicId })
      .populate("domainId", "publicId")
      .populate("pageId", "publicId")
      .populate("crawlSourceId", "publicId")
      .exec();
  }

  async findByChecksum(checksum: string): Promise<IRawDocumentDocument | null> {
    return await RawDocumentModel.findOne({ "storage.checksum": checksum })
      .populate("domainId", "publicId")
      .populate("pageId", "publicId")
      .populate("crawlSourceId", "publicId")
      .exec();
  }

  async list(filter: Record<string, unknown>, page = 1, limit = 20): Promise<{ documents: IRawDocumentDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [documents, total] = await Promise.all([
      RawDocumentModel.find(filter)
        .populate("domainId", "publicId")
        .populate("pageId", "publicId")
        .populate("crawlSourceId", "publicId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      RawDocumentModel.countDocuments(filter).exec(),
    ]);

    return { documents, total };
  }
}
