import { Request, Response, NextFunction } from "express";
import { GscPropertyService } from "../services/gsc_property.service";
import { createGscPropertySchema, updateGscPropertySchema, queryGscPropertySchema } from "../validators/gsc_property.validator";

export class GscPropertyController {
  constructor(private readonly gscPropertyService: GscPropertyService = new GscPropertyService()) {}

  createGscProperty = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createGscPropertySchema.parse(req.body);
      const prop = await this.gscPropertyService.createGscProperty(validatedData);
      res.status(201).json({
        success: true,
        data: prop,
      });
    } catch (error) {
      next(error);
    }
  };

  getGscPropertyByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const prop = await this.gscPropertyService.getGscPropertyByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: prop,
      });
    } catch (error) {
      next(error);
    }
  };

  listGscProperties = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryGscPropertySchema.parse(req.query);
      const result = await this.gscPropertyService.listGscProperties(query);
      res.status(200).json({
        success: true,
        data: result.properties,
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

  updateGscProperty = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateGscPropertySchema.parse(req.body);
      const prop = await this.gscPropertyService.updateGscProperty(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: prop,
      });
    } catch (error) {
      next(error);
    }
  };
}
