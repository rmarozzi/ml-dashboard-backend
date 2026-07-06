import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// GET /channels/status — lista todas as contas conectadas (ML + Shopee)
router.get("/status", requireAuth, async (req, res) => {
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
  const now = new Date();
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const accounts = await prisma.channelAccount.findMany({
    where: { userId: liderId },
    select: {
      id:                true,
      channelType:       true,
      externalAccountId: true,
      externalNickname:  true,
      apelido:           true,
      initialSyncDone:   true,
      lastSyncAt:        true,
      tokenExpiresAt:    true,
      createdAt:         true,
    },
    orderBy: { createdAt: "asc" },
  });

  return res.json({
    accounts: accounts.map((a) => ({
      ...a,
      isExpired:      a.tokenExpiresAt < now,
      isExpiringSoon: a.tokenExpiresAt < soon && a.tokenExpiresAt >= now,
    })),
  });
});

// DELETE /channels/disconnect/:accountId — desconecta qualquer canal
router.delete("/disconnect/:accountId", requireAuth, async (req, res) => {
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const account = await prisma.channelAccount.findFirst({
    where: { id: req.params.accountId, userId: liderId },
  });

  if (!account) return res.status(404).json({ message: "Conta não encontrada" });

  await prisma.channelAccount.delete({ where: { id: account.id } });
  return res.json({ ok: true });
});

export default router;