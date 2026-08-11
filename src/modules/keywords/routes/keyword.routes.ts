import { Router } from "express";
import { KeywordController } from "../controllers/keyword.controller";

const router = Router();
const controller = new KeywordController();

router.post("/", controller.createKeyword);
router.get("/", controller.listKeywords);
router.get("/:publicId", controller.getKeywordByPublicId);
router.patch("/:publicId", controller.updateKeyword);
router.delete("/:publicId", controller.deleteKeyword);

export default router;
