import { Request, Response, NextFunction } from "express";
import { CrawlSnapshotService } from "../services/crawl_snapshot.service";
import { createCrawlSnapshotSchema, queryCrawlSnapshotSchema } from "../validators/crawl_snapshot.validator";

export class CrawlSnapshotController {
  constructor(private readonly crawlSnapshotService: CrawlSnapshotService = new CrawlSnapshotService()) {}

  createCrawlSnapshot = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createCrawlSnapshotSchema.parse(req.body);
      const snapshot = await this.crawlSnapshotService.createCrawlSnapshot(validatedData);
      res.status(201).json({
        success: true,
        data: snapshot,
      });
    } catch (error) {
      next(error);
    }
  };

  getCrawlSnapshotByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const snapshot = await this.crawlSnapshotService.getCrawlSnapshotByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: snapshot,
      });
    } catch (error) {
      next(error);
    }
  };

  listCrawlSnapshots = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryCrawlSnapshotSchema.parse(req.query);
      const result = await this.crawlSnapshotService.listCrawlSnapshots(query);
      res.status(200).json({
        success: true,
        data: result.snapshots,
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
