import { Request, Response, NextFunction } from "express";
import { KeywordRankingService } from "../services/keyword_ranking.service";
import { createKeywordRankingSchema, queryKeywordRankingSchema } from "../validators/keyword_ranking.validator";

export class KeywordRankingController {
  constructor(private readonly keywordRankingService: KeywordRankingService = new KeywordRankingService()) {}

  createKeywordRanking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createKeywordRankingSchema.parse(req.body);
      const ranking = await this.keywordRankingService.createKeywordRanking(validatedData);
      res.status(201).json({
        success: true,
        data: ranking,
      });
    } catch (error) {
      next(error);
    }
  };

  getKeywordRankingByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const ranking = await this.keywordRankingService.getKeywordRankingByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: ranking,
      });
    } catch (error) {
      next(error);
    }
  };

  listKeywordRankings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryKeywordRankingSchema.parse(req.query);
      const result = await this.keywordRankingService.listKeywordRankings(query);
      res.status(200).json({
        success: true,
        data: result.rankings,
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
