import { Router } from "express";
import { DomainController } from "../controllers/domain.controller";

const router = Router();
const controller = new DomainController();

router.post("/", controller.createDomain);
router.get("/", controller.listDomains);
router.get("/:publicId", controller.getDomainByPublicId);
router.patch("/:publicId", controller.updateDomain);
router.delete("/:publicId", controller.deleteDomain);

export default router;
