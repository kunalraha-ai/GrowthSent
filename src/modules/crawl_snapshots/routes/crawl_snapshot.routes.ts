import { Router } from "express";
import { CrawlSnapshotController } from "../controllers/crawl_snapshot.controller";

const router = Router();
const controller = new CrawlSnapshotController();

router.post("/", controller.createCrawlSnapshot);
router.get("/", controller.listCrawlSnapshots);
router.get("/:publicId", controller.getCrawlSnapshotByPublicId);

export default router;
