import { Request, Response, NextFunction } from "express";
import { BacklinkService } from "../services/backlink.service";
import { createBacklinkSchema, updateBacklinkSchema, queryBacklinkSchema } from "../validators/backlink.validator";

export class BacklinkController {
  constructor(private readonly backlinkService: BacklinkService = new BacklinkService()) {}

  createBacklink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createBacklinkSchema.parse(req.body);
      const backlink = await this.backlinkService.createBacklink(validatedData);
      res.status(201).json({
        success: true,
        data: backlink,
      });
    } catch (error) {
      next(error);
    }
  };

  getBacklinkByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const backlink = await this.backlinkService.getBacklinkByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: backlink,
      });
    } catch (error) {
      next(error);
    }
  };

  listBacklinks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryBacklinkSchema.parse(req.query);
      const result = await this.backlinkService.listBacklinks(query);
      res.status(200).json({
        success: true,
        data: result.backlinks,
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

  updateBacklink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateBacklinkSchema.parse(req.body);
      const backlink = await this.backlinkService.updateBacklink(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: backlink,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteBacklink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.backlinkService.deleteBacklink(publicId);
      res.status(200).json({
        success: true,
        message: "Backlink deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
