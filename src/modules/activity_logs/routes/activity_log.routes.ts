import { Router } from "express";
import { ActivityLogController } from "../controllers/activity_log.controller";

const router = Router();
const controller = new ActivityLogController();

router.post("/", controller.createActivityLog);
router.get("/", controller.listActivityLogs);
router.get("/:publicId", controller.getActivityLogByPublicId);

export default router;
