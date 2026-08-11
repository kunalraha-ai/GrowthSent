import { Request, Response, NextFunction } from "express";
import { DomainService } from "../services/domain.service";
import { createDomainSchema, updateDomainSchema, queryDomainSchema } from "../validators/domain.validator";

export class DomainController {
  constructor(private readonly domainService: DomainService = new DomainService()) {}

  createDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createDomainSchema.parse(req.body);
      const domain = await this.domainService.createDomain(validatedData);
      res.status(201).json({
        success: true,
        data: domain,
      });
    } catch (error) {
      next(error);
    }
  };

  getDomainByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const domain = await this.domainService.getDomainByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: domain,
      });
    } catch (error) {
      next(error);
    }
  };

  listDomains = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryDomainSchema.parse(req.query);
      const result = await this.domainService.listDomains(query);
      res.status(200).json({
        success: true,
        data: result.domains,
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

  updateDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateDomainSchema.parse(req.body);
      const domain = await this.domainService.updateDomain(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: domain,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.domainService.deleteDomain(publicId);
      res.status(200).json({
        success: true,
        message: "Domain deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
