import { Request, Response, NextFunction } from "express";
import { PageAiOutputService } from "../services/page_ai_output.service";
import { createPageAiOutputSchema, queryPageAiOutputSchema } from "../validators/page_ai_output.validator";

export class PageAiOutputController {
  constructor(private readonly pageAiOutputService: PageAiOutputService = new PageAiOutputService()) {}

  createPageAiOutput = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createPageAiOutputSchema.parse(req.body);
      const output = await this.pageAiOutputService.createPageAiOutput(validatedData);
      res.status(201).json({
        success: true,
        data: output,
      });
    } catch (error) {
      next(error);
    }
  };

  getPageAiOutputByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const output = await this.pageAiOutputService.getPageAiOutputByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: output,
      });
    } catch (error) {
      next(error);
    }
  };

  listPageAiOutputs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryPageAiOutputSchema.parse(req.query);
      const result = await this.pageAiOutputService.listPageAiOutputs(query);
      res.status(200).json({
        success: true,
        data: result.aiOutputs,
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
