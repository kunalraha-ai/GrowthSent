import { Request, Response, NextFunction } from "express";
import { SystemSettingService } from "../services/system_setting.service";
import { upsertSystemSettingSchema, querySystemSettingSchema } from "../validators/system_setting.validator";

export class SystemSettingController {
  constructor(private readonly systemSettingService: SystemSettingService = new SystemSettingService()) {}

  upsertSystemSetting = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = upsertSystemSettingSchema.parse(req.body);
      const setting = await this.systemSettingService.upsertSystemSetting(validatedData);
      res.status(200).json({
        success: true,
        data: setting,
      });
    } catch (error) {
      next(error);
    }
  };

  getSystemSettingByKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = String(req.params.key);
      const setting = await this.systemSettingService.getSystemSettingByKey(key);
      res.status(200).json({
        success: true,
        data: setting,
      });
    } catch (error) {
      next(error);
    }
  };

  listSystemSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = querySystemSettingSchema.parse(req.query);
      const result = await this.systemSettingService.listSystemSettings(query);
      res.status(200).json({
        success: true,
        data: result.settings,
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
