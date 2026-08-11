import { Request, Response, NextFunction } from "express";
import { KeywordService } from "../services/keyword.service";
import { createKeywordSchema, updateKeywordSchema, queryKeywordSchema } from "../validators/keyword.validator";

export class KeywordController {
  constructor(private readonly keywordService: KeywordService = new KeywordService()) {}

  createKeyword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createKeywordSchema.parse(req.body);
      const keyword = await this.keywordService.createKeyword(validatedData);
      res.status(201).json({
        success: true,
        data: keyword,
      });
    } catch (error) {
      next(error);
    }
  };

  getKeywordByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const keyword = await this.keywordService.getKeywordByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: keyword,
      });
    } catch (error) {
      next(error);
    }
  };

  listKeywords = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryKeywordSchema.parse(req.query);
      const result = await this.keywordService.listKeywords(query);
      res.status(200).json({
        success: true,
        data: result.keywords,
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

  updateKeyword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateKeywordSchema.parse(req.body);
      const keyword = await this.keywordService.updateKeyword(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: keyword,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteKeyword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.keywordService.deleteKeyword(publicId);
      res.status(200).json({
        success: true,
        message: "Keyword deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
