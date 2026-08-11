import { Router } from "express";
import { GscPropertyController } from "../controllers/gsc_property.controller";

const router = Router();
const controller = new GscPropertyController();

router.post("/", controller.createGscProperty);
router.get("/", controller.listGscProperties);
router.get("/:publicId", controller.getGscPropertyByPublicId);
router.patch("/:publicId", controller.updateGscProperty);

export default router;
