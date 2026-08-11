import { Router } from "express";
import { CacheStatController } from "../controllers/cache_stat.controller";

const router = Router();
const controller = new CacheStatController();

router.post("/", controller.upsertCacheStat);
router.get("/domain/:domainPublicId/key/:key", controller.getCacheStat);

export default router;
