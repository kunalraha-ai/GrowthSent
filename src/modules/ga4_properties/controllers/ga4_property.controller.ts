import { Request, Response, NextFunction } from "express";
import { Ga4PropertyService } from "../services/ga4_property.service";
import { createGa4PropertySchema, updateGa4PropertySchema, queryGa4PropertySchema } from "../validators/ga4_property.validator";

export class Ga4PropertyController {
  constructor(private readonly ga4PropertyService: Ga4PropertyService = new Ga4PropertyService()) {}

  createGa4Property = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createGa4PropertySchema.parse(req.body);
      const prop = await this.ga4PropertyService.createGa4Property(validatedData);
      res.status(201).json({
        success: true,
        data: prop,
      });
    } catch (error) {
      next(error);
    }
  };

  getGa4PropertyByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const prop = await this.ga4PropertyService.getGa4PropertyByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: prop,
      });
    } catch (error) {
      next(error);
    }
  };

  listGa4Properties = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryGa4PropertySchema.parse(req.query);
      const result = await this.ga4PropertyService.listGa4Properties(query);
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

  updateGa4Property = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateGa4PropertySchema.parse(req.body);
      const prop = await this.ga4PropertyService.updateGa4Property(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: prop,
      });
    } catch (error) {
      next(error);
    }
  };
}
