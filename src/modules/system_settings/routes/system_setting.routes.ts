import { Router } from "express";
import { SystemSettingController } from "../controllers/system_setting.controller";

const router = Router();
const controller = new SystemSettingController();

router.post("/", controller.upsertSystemSetting);
router.get("/", controller.listSystemSettings);
router.get("/key/:key", controller.getSystemSettingByKey);

export default router;
