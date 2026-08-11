import { Request, Response, NextFunction } from "express";
import { ActivityLogService } from "../services/activity_log.service";
import { createActivityLogSchema, queryActivityLogSchema } from "../validators/activity_log.validator";

export class ActivityLogController {
  constructor(private readonly activityLogService: ActivityLogService = new ActivityLogService()) {}

  createActivityLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createActivityLogSchema.parse(req.body);
      const log = await this.activityLogService.createActivityLog(validatedData);
      res.status(201).json({
        success: true,
        data: log,
      });
    } catch (error) {
      next(error);
    }
  };

  getActivityLogByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const log = await this.activityLogService.getActivityLogByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: log,
      });
    } catch (error) {
      next(error);
    }
  };

  listActivityLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryActivityLogSchema.parse(req.query);
      const result = await this.activityLogService.listActivityLogs(query);
      res.status(200).json({
        success: true,
        data: result.logs,
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
