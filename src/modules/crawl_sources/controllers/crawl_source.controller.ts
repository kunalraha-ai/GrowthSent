import { Request, Response, NextFunction } from "express";
import { CrawlSourceService } from "../services/crawl_source.service";
import { createCrawlSourceSchema, updateCrawlSourceSchema, queryCrawlSourceSchema } from "../validators/crawl_source.validator";

export class CrawlSourceController {
  constructor(private readonly crawlSourceService: CrawlSourceService = new CrawlSourceService()) {}

  createCrawlSource = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createCrawlSourceSchema.parse(req.body);
      const source = await this.crawlSourceService.createCrawlSource(validatedData);
      res.status(201).json({
        success: true,
        data: source,
      });
    } catch (error) {
      next(error);
    }
  };

  getCrawlSourceByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const source = await this.crawlSourceService.getCrawlSourceByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: source,
      });
    } catch (error) {
      next(error);
    }
  };

  listCrawlSources = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryCrawlSourceSchema.parse(req.query);
      const result = await this.crawlSourceService.listCrawlSources(query);
      res.status(200).json({
        success: true,
        data: result.sources,
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

  updateCrawlSource = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateCrawlSourceSchema.parse(req.body);
      const source = await this.crawlSourceService.updateCrawlSource(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: source,
      });
    } catch (error) {
      next(error);
    }
  };
}
