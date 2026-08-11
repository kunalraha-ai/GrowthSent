import { Router } from "express";
import { Ga4PropertyController } from "../controllers/ga4_property.controller";

const router = Router();
const controller = new Ga4PropertyController();

router.post("/", controller.createGa4Property);
router.get("/", controller.listGa4Properties);
router.get("/:publicId", controller.getGa4PropertyByPublicId);
router.patch("/:publicId", controller.updateGa4Property);

export default router;
