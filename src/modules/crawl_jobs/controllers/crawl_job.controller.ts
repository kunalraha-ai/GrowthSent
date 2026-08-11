import { Request, Response, NextFunction } from "express";
import { CrawlJobService } from "../services/crawl_job.service";
import { createCrawlJobSchema, updateCrawlJobSchema, queryCrawlJobSchema } from "../validators/crawl_job.validator";

export class CrawlJobController {
  constructor(private readonly crawlJobService: CrawlJobService = new CrawlJobService()) {}

  createCrawlJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createCrawlJobSchema.parse(req.body);
      const job = await this.crawlJobService.createCrawlJob(validatedData);
      res.status(201).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  };

  getCrawlJobByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const job = await this.crawlJobService.getCrawlJobByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  };

  listCrawlJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryCrawlJobSchema.parse(req.query);
      const result = await this.crawlJobService.listCrawlJobs(query);
      res.status(200).json({
        success: true,
        data: result.jobs,
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

  updateCrawlJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateCrawlJobSchema.parse(req.body);
      const job = await this.crawlJobService.updateCrawlJob(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  };
}
