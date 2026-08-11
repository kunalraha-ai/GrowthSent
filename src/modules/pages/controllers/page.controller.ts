import { Request, Response, NextFunction } from "express";
import { PageService } from "../services/page.service";
import { createPageSchema, updatePageSchema, queryPageSchema } from "../validators/page.validator";

export class PageController {
  constructor(private readonly pageService: PageService = new PageService()) {}

  createPage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createPageSchema.parse(req.body);
      const page = await this.pageService.createPage(validatedData);
      res.status(201).json({
        success: true,
        data: page,
      });
    } catch (error) {
      next(error);
    }
  };

  getPageByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const page = await this.pageService.getPageByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: page,
      });
    } catch (error) {
      next(error);
    }
  };

  listPages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryPageSchema.parse(req.query);
      const result = await this.pageService.listPages(query);
      res.status(200).json({
        success: true,
        data: result.pages,
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

  updatePage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updatePageSchema.parse(req.body);
      const page = await this.pageService.updatePage(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: page,
      });
    } catch (error) {
      next(error);
    }
  };

  deletePage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.pageService.deletePage(publicId);
      res.status(200).json({
        success: true,
        message: "Page deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
