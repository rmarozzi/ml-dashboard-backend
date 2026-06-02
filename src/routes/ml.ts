import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

router.get("/status", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const tokens = await prisma.token.findMany({ where: { userId: liderId } });

  return res.json({
    tokens: tokens.map((t) => ({
      ...t,
      accessToken: undefined,
      refreshToken: undefined,
      isExpired: t.expiresAt < new Date(),
      isExpiringSoon: t.expiresAt < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })),
  });
});

router.delete("/disconnect/:tokenId", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const token = await prisma.token.findFirst({
    where: { id: parseInt(String(req.params.tokenId)), userId: liderId },
  });
  if (!token) return res.status(404).json({ message: "Token não encontrado" });

  await prisma.token.delete({ where: { id: token.id } });
  return res.json({ ok: true });
});

export default router;
