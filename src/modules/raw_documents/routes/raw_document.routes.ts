import { Router } from "express";
import { RawDocumentController } from "../controllers/raw_document.controller";

const router = Router();
const controller = new RawDocumentController();

router.post("/", controller.createRawDocument);
router.get("/", controller.listRawDocuments);
router.get("/:publicId", controller.getRawDocumentByPublicId);

export default router;
