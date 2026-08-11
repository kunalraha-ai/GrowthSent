import { Request, Response, NextFunction } from "express";
import { CacheStatService } from "../services/cache_stat.service";
import { upsertCacheStatSchema } from "../validators/cache_stat.validator";

export class CacheStatController {
  constructor(private readonly cacheStatService: CacheStatService = new CacheStatService()) {}

  upsertCacheStat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = upsertCacheStatSchema.parse(req.body);
      const stat = await this.cacheStatService.upsertCacheStat(validatedData);
      res.status(200).json({
        success: true,
        data: stat,
      });
    } catch (error) {
      next(error);
    }
  };

  getCacheStat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const domainPublicId = String(req.params.domainPublicId);
      const key = String(req.params.key);
      const stat = await this.cacheStatService.getCacheStat(domainPublicId, key);
      res.status(200).json({
        success: true,
        data: stat,
      });
    } catch (error) {
      next(error);
    }
  };
}
