import { Request, Response, NextFunction } from "express";
import { PageAuditService } from "../services/page_audit.service";
import { createPageAuditSchema, queryPageAuditSchema } from "../validators/page_audit.validator";

export class PageAuditController {
  constructor(private readonly pageAuditService: PageAuditService = new PageAuditService()) {}

  createPageAudit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createPageAuditSchema.parse(req.body);
      const audit = await this.pageAuditService.createPageAudit(validatedData);
      res.status(201).json({
        success: true,
        data: audit,
      });
    } catch (error) {
      next(error);
    }
  };

  getPageAuditByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const audit = await this.pageAuditService.getPageAuditByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: audit,
      });
    } catch (error) {
      next(error);
    }
  };

  listPageAudits = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryPageAuditSchema.parse(req.query);
      const result = await this.pageAuditService.listPageAudits(query);
      res.status(200).json({
        success: true,
        data: result.audits,
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
