import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { settings: true } });
  const settings = user?.settings ? JSON.parse(user.settings) : {};
  return res.json({ settings });
});

router.post("/", requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { settings: JSON.stringify(req.body) },
  });
  return res.json({ ok: true });
});

export default router;
