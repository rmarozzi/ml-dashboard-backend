import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// GET /ml/status — lista contas ML conectadas via ChannelAccount
router.get("/status", requireAuth, async (req, res) => {
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const accounts = await prisma.channelAccount.findMany({
  where: { userId: liderId, channelType: "MERCADO_LIVRE" },
  select: {
    id:                true,
    channelType:       true,  // ← adicionar esta linha
    externalAccountId: true,
    externalNickname:  true,
    apelido:           true,
    initialSyncDone:   true,
    lastSyncAt:        true,
    tokenExpiresAt:    true,
    createdAt:         true,
  },
});

  return res.json({
    accounts: accounts.map((a) => ({
      ...a,
      isExpired:      a.tokenExpiresAt < new Date(),
      isExpiringSoon: a.tokenExpiresAt < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })),
  });
});

// DELETE /ml/disconnect/:accountId — desconecta uma conta ML
router.delete("/disconnect/:accountId", requireAuth, async (req, res) => {
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const account = await prisma.channelAccount.findFirst({
    where: {
      id:          req.params.accountId,
      userId:      liderId,
      channelType: "MERCADO_LIVRE",
    },
  });

  if (!account) return res.status(404).json({ message: "Conta não encontrada" });

  await prisma.channelAccount.delete({ where: { id: account.id } });
  return res.json({ ok: true });
});

export default router;