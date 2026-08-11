import { Router } from "express";
import { PageMetadataController } from "../controllers/page_metadata.controller";

const router = Router();
const controller = new PageMetadataController();

router.post("/", controller.upsertPageMetadata);
router.get("/", controller.listMetadata);
router.get("/page/:pagePublicId", controller.getMetadataByPagePublicId);

export default router;
