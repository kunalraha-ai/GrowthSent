import { Request, Response, NextFunction } from "express";
import { PageMetadataService } from "../services/page_metadata.service";
import { upsertPageMetadataSchema, queryPageMetadataSchema } from "../validators/page_metadata.validator";

export class PageMetadataController {
  constructor(private readonly pageMetadataService: PageMetadataService = new PageMetadataService()) {}

  upsertPageMetadata = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = upsertPageMetadataSchema.parse(req.body);
      const metadata = await this.pageMetadataService.upsertPageMetadata(validatedData);
      res.status(200).json({
        success: true,
        data: metadata,
      });
    } catch (error) {
      next(error);
    }
  };

  getMetadataByPagePublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pagePublicId = String(req.params.pagePublicId);
      const metadata = await this.pageMetadataService.getMetadataByPagePublicId(pagePublicId);
      res.status(200).json({
        success: true,
        data: metadata,
      });
    } catch (error) {
      next(error);
    }
  };

  listMetadata = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryPageMetadataSchema.parse(req.query);
      const result = await this.pageMetadataService.listMetadata(query);
      res.status(200).json({
        success: true,
        data: result.metadataList,
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
