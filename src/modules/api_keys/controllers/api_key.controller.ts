import { Request, Response, NextFunction } from "express";
import { ApiKeyService } from "../services/api_key.service";
import { createApiKeySchema, updateApiKeySchema, queryApiKeySchema } from "../validators/api_key.validator";

export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService = new ApiKeyService()) {}

  createApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createApiKeySchema.parse(req.body);
      const key = await this.apiKeyService.createApiKey(validatedData);
      res.status(201).json({
        success: true,
        data: key,
      });
    } catch (error) {
      next(error);
    }
  };

  getApiKeyByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const key = await this.apiKeyService.getApiKeyByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: key,
      });
    } catch (error) {
      next(error);
    }
  };

  listApiKeys = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryApiKeySchema.parse(req.query);
      const result = await this.apiKeyService.listApiKeys(query);
      res.status(200).json({
        success: true,
        data: result.apiKeys,
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

  updateApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateApiKeySchema.parse(req.body);
      const key = await this.apiKeyService.updateApiKey(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: key,
      });
    } catch (error) {
      next(error);
    }
  };

  revokeApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const key = await this.apiKeyService.revokeApiKey(publicId);
      res.status(200).json({
        success: true,
        data: key,
        message: "API key revoked successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
