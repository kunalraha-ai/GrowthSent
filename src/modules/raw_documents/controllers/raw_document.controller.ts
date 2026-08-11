import { Request, Response, NextFunction } from "express";
import { RawDocumentService } from "../services/raw_document.service";
import { createRawDocumentSchema, queryRawDocumentSchema } from "../validators/raw_document.validator";

export class RawDocumentController {
  constructor(private readonly rawDocumentService: RawDocumentService = new RawDocumentService()) {}

  createRawDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createRawDocumentSchema.parse(req.body);
      const doc = await this.rawDocumentService.createRawDocument(validatedData);
      res.status(201).json({
        success: true,
        data: doc,
      });
    } catch (error) {
      next(error);
    }
  };

  getRawDocumentByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const doc = await this.rawDocumentService.getRawDocumentByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: doc,
      });
    } catch (error) {
      next(error);
    }
  };

  listRawDocuments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryRawDocumentSchema.parse(req.query);
      const result = await this.rawDocumentService.listRawDocuments(query);
      res.status(200).json({
        success: true,
        data: result.documents,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
