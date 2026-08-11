import { Router } from "express";
import { BacklinkController } from "../controllers/backlink.controller";

const router = Router();
const controller = new BacklinkController();

router.post("/", controller.createBacklink);
router.get("/", controller.listBacklinks);
router.get("/:publicId", controller.getBacklinkByPublicId);
router.patch("/:publicId", controller.updateBacklink);
router.delete("/:publicId", controller.deleteBacklink);

export default router;
