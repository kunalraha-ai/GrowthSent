import { Router } from "express";
import { ProjectController } from "../controllers/project.controller";

const router = Router();
const controller = new ProjectController();

router.post("/", controller.createProject);
router.get("/", controller.listProjects);
router.get("/:publicId", controller.getProjectByPublicId);
router.patch("/:publicId", controller.updateProject);
router.delete("/:publicId", controller.deleteProject);

export default router;
