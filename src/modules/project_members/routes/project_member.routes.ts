import { Router } from "express";
import { ProjectMemberController } from "../controllers/project_member.controller";

const router = Router();
const controller = new ProjectMemberController();

router.post("/", controller.addMember);
router.get("/", controller.listMembers);
router.get("/:publicId", controller.getMemberByPublicId);
router.patch("/:publicId", controller.updateMember);
router.delete("/:publicId", controller.removeMember);

export default router;
