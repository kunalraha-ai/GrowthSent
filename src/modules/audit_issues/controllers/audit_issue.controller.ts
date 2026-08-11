import { Request, Response, NextFunction } from "express";
import { AuditIssueService } from "../services/audit_issue.service";
import { createAuditIssueSchema, updateAuditIssueSchema, queryAuditIssueSchema } from "../validators/audit_issue.validator";

export class AuditIssueController {
  constructor(private readonly auditIssueService: AuditIssueService = new AuditIssueService()) {}

  createAuditIssue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createAuditIssueSchema.parse(req.body);
      const issue = await this.auditIssueService.createAuditIssue(validatedData);
      res.status(201).json({
        success: true,
        data: issue,
      });
    } catch (error) {
      next(error);
    }
  };

  getAuditIssueByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const issue = await this.auditIssueService.getAuditIssueByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: issue,
      });
    } catch (error) {
      next(error);
    }
  };

  listAuditIssues = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryAuditIssueSchema.parse(req.query);
      const result = await this.auditIssueService.listAuditIssues(query);
      res.status(200).json({
        success: true,
        data: result.issues,
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

  updateAuditIssue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateAuditIssueSchema.parse(req.body);
      const issue = await this.auditIssueService.updateAuditIssue(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: issue,
      });
    } catch (error) {
      next(error);
    }
  };
}
