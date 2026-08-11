import { Request, Response, NextFunction } from "express";
import { ProjectService } from "../services/project.service";
import { createProjectSchema, updateProjectSchema, queryProjectSchema } from "../validators/project.validator";

export class ProjectController {
  constructor(private readonly projectService: ProjectService = new ProjectService()) {}

  createProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedData = createProjectSchema.parse(req.body);
      const project = await this.projectService.createProject(validatedData);
      res.status(201).json({
        success: true,
        data: project,
      });
    } catch (error) {
      next(error);
    }
  };

  getProjectByPublicId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const project = await this.projectService.getProjectByPublicId(publicId);
      res.status(200).json({
        success: true,
        data: project,
      });
    } catch (error) {
      next(error);
    }
  };

  listProjects = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = queryProjectSchema.parse(req.query);
      const result = await this.projectService.listProjects(query);
      res.status(200).json({
        success: true,
        data: result.projects,
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

  updateProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      const validatedData = updateProjectSchema.parse(req.body);
      const project = await this.projectService.updateProject(publicId, validatedData);
      res.status(200).json({
        success: true,
        data: project,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const publicId = String(req.params.publicId);
      await this.projectService.deleteProject(publicId);
      res.status(200).json({
        success: true,
        message: "Project deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
