import { Router } from "express";
import { PageAiOutputController } from "../controllers/page_ai_output.controller";

const router = Router();
const controller = new PageAiOutputController();

router.post("/", controller.createPageAiOutput);
router.get("/", controller.listPageAiOutputs);
router.get("/:publicId", controller.getPageAiOutputByPublicId);

export default router;
