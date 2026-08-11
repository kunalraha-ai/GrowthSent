import { Router } from "express";
import { CrawlSourceController } from "../controllers/crawl_source.controller";

const router = Router();
const controller = new CrawlSourceController();

router.post("/", controller.createCrawlSource);
router.get("/", controller.listCrawlSources);
router.get("/:publicId", controller.getCrawlSourceByPublicId);
router.patch("/:publicId", controller.updateCrawlSource);

export default router;
