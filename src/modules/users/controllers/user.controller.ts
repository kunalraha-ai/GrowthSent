import { Request, Response, NextFunction } from "express";
import { UserService } from "../services/user.service";
import { createUserSchema, updateUserSchema, queryUserSchema } from "../validators/user.validator";

export class UserController {
  constructor(private readonly userService: UserService = new UserService()) {}

  createUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createUserSchema.parse({
        ...req.body,
        signupIp: req.ip,
      });
      const user = await this.userService.createUser(validatedData);
      res.status(201).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  getUserByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const user = await this.userService.getUserByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  listUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryUserSchema.parse(req.query);
      const result = await this.userService.listUsers(query);
      res.status(200).json({
        success: true,
        data: result.users,
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

  updateUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateUserSchema.parse(req.body);
      const user = await this.userService.updateUser(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.userService.deleteUser(publicId);
      res.status(200).json({
        success: true,
        message: "User deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
