import { Router } from "express";
import { KeywordRankingController } from "../controllers/keyword_ranking.controller";

const router = Router();
const controller = new KeywordRankingController();

router.post("/", controller.createKeywordRanking);
router.get("/", controller.listKeywordRankings);
router.get("/:publicId", controller.getKeywordRankingByPublicId);

export default router;
