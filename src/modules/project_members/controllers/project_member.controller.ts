import { Request, Response, NextFunction } from "express";
import { ProjectMemberService } from "../services/project_member.service";
import { addProjectMemberSchema, updateProjectMemberSchema, queryProjectMemberSchema } from "../validators/project_member.validator";

export class ProjectMemberController {
  constructor(private readonly projectMemberService: ProjectMemberService = new ProjectMemberService()) {}

  addMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = addProjectMemberSchema.parse(req.body);
      const member = await this.projectMemberService.addMember(validatedData);
      res.status(201).json({
        success: true,
        data: member,
      });
    } catch (error) {
      next(error);
    }
  };

  getMemberByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const member = await this.projectMemberService.getMemberByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: member,
      });
    } catch (error) {
      next(error);
    }
  };

  listMembers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryProjectMemberSchema.parse(req.query);
      const result = await this.projectMemberService.listMembers(query);
      res.status(200).json({
        success: true,
        data: result.members,
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

  updateMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateProjectMemberSchema.parse(req.body);
      const member = await this.projectMemberService.updateMember(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: member,
      });
    } catch (error) {
      next(error);
    }
  };

  removeMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.projectMemberService.removeMember(publicId);
      res.status(200).json({
        success: true,
        message: "Project member removed successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
