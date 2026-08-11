import { Router } from "express";
import { PageAuditController } from "../controllers/page_audit.controller";

const router = Router();
const controller = new PageAuditController();

router.post("/", controller.createPageAudit);
router.get("/", controller.listPageAudits);
router.get("/:publicId", controller.getPageAuditByPublicId);

export default router;
