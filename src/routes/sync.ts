// src/routes/sync.ts
//
// Rotas HTTP de sincronização. A lógica de sync em si agora vive em
// src/lib/syncEngine.ts — este arquivo só expõe as rotas.

import { Router } from "express";
import prisma from "../lib/prisma";
import { getValidToken, getMlClient } from "../lib/ml";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";
import { syncOrdersForUser } from "../lib/syncEngine";

const router = Router();

// GET /orders/sync
router.get("/", requireAuth, requireFuncionarioPermission("sync_ml"), async (req, res) => {
  const liderId = await getLiderId(req.user);
  const results = await syncOrdersForUser(liderId);
  return res.json({ ok: true, results });
});

// GET /sync/status
router.get("/status", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const lider = await prisma.user.findUnique({ where: { id: liderId }, select: { lastSyncAt: true } });
  return res.json({ lastSyncAt: lider?.lastSyncAt });
});

// GET /orders/sync/preview (Premium only) — inalterada, continua sendo um
// dry-run leve sobre os últimos 20 pedidos, sem gravar nada.
router.get("/preview", requireAuth, async (req, res) => {
  const user = req.user;
  if (user.role !== "admin" && user.subscription?.plan?.slug !== "premium") {
    return res.status(403).json({ message: "Disponível apenas no plano Premium" });
  }
  const liderId = await getLiderId(user);
  const tokens = await prisma.token.findMany({ where: { userId: liderId }, take: 1 });
  if (!tokens.length) return res.json({ new: 0, updated: 0, unchanged: 0, orders: [] });

  const validToken = await getValidToken(tokens[0].id);
  const mlClient = getMlClient(validToken.accessToken);

  let sellerId = validToken.mlUserId;
  if (!sellerId) {
    const meRes = await mlClient.get("/users/me");
    sellerId = String(meRes.data.id);
  }

  const mlRes = await mlClient.get("/orders/search", {
    params: { seller: sellerId, sort: "date_desc", limit: 20 },
  });
  const mlOrders = mlRes.data.results ?? [];

  let newCount = 0, updatedCount = 0, unchangedCount = 0;
  for (const o of mlOrders) {
    const existing = await prisma.order.findUnique({ where: { mlId: String(o.id) } });
    if (!existing) newCount++;
    else if (existing.status !== o.status) updatedCount++;
    else unchangedCount++;
  }

  return res.json({ new: newCount, updated: updatedCount, unchanged: unchangedCount, orders: mlOrders.slice(0, 5) });
});

export default router;