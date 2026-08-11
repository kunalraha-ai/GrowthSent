import { Router } from "express";
import { PageController } from "../controllers/page.controller";

const router = Router();
const controller = new PageController();

router.post("/", controller.createPage);
router.get("/", controller.listPages);
router.get("/:publicId", controller.getPageByPublicId);
router.patch("/:publicId", controller.updatePage);
router.delete("/:publicId", controller.deletePage);

export default router;
