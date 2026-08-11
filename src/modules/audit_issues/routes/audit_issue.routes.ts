import { Router } from "express";
import { AuditIssueController } from "../controllers/audit_issue.controller";

const router = Router();
const controller = new AuditIssueController();

router.post("/", controller.createAuditIssue);
router.get("/", controller.listAuditIssues);
router.get("/:publicId", controller.getAuditIssueByPublicId);
router.patch("/:publicId", controller.updateAuditIssue);

export default router;
