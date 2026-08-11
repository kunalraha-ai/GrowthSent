import { Router } from "express";
import { UserController } from "../controllers/user.controller";

const router = Router();
const controller = new UserController();

router.post("/", controller.createUser);
router.get("/", controller.listUsers);
router.get("/:publicId", controller.getUserByPublicId);
router.patch("/:publicId", controller.updateUser);
router.delete("/:publicId", controller.deleteUser);

export default router;
