import { Router } from "express";
import { CrawlJobController } from "../controllers/crawl_job.controller";

const router = Router();
const controller = new CrawlJobController();

router.post("/", controller.createCrawlJob);
router.get("/", controller.listCrawlJobs);
router.get("/:publicId", controller.getCrawlJobByPublicId);
router.patch("/:publicId", controller.updateCrawlJob);

export default router;
