import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";
import prisma from "../lib/prisma";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  if (req.user.role === "funcionario") {
    return res.status(403).json({ message: "Funcionários não visualizam assinatura" });
  }
  const liderId = await getLiderId(req.user);
  const subscription = await prisma.subscription.findUnique({
    where: { userId: liderId },
    include: { plan: true },
  });
  return res.json({ subscription });
});

export default router;
