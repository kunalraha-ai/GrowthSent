import { Router } from "express";
import { ApiKeyController } from "../controllers/api_key.controller";

const router = Router();
const controller = new ApiKeyController();

router.post("/", controller.createApiKey);
router.get("/", controller.listApiKeys);
router.get("/:publicId", controller.getApiKeyByPublicId);
router.patch("/:publicId", controller.updateApiKey);
router.post("/:publicId/revoke", controller.revokeApiKey);

export default router;
