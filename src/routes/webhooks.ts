import { Router } from "express";
import prisma from "../lib/prisma";
import { syncEngine } from "../sync/SyncEngine";

const router = Router();

// Cache de pedidos processados recentemente — evita duplicatas do ML
const recentlyProcessed = new Map<string, number>();

router.post("/ml", async (req, res) => {
  // Responde imediatamente — ML exige resposta em < 500ms
  res.sendStatus(200);

  if (!req.body || typeof req.body !== "object") return;

  const { topic, resource, user_id } = req.body;

  if (topic !== "orders" && topic !== "orders_v2") return;
  if (!resource || !user_id) return;

  const orderId = String(resource).replace("/orders/", "").trim();
  if (!orderId || isNaN(Number(orderId))) return;

  // Debounce — ignora se o mesmo pedido foi processado nos últimos 30s
  const cacheKey = `${user_id}:${orderId}`;
  const lastProcessed = recentlyProcessed.get(cacheKey);
  if (lastProcessed && Date.now() - lastProcessed < 30_000) return;
  recentlyProcessed.set(cacheKey, Date.now());
  setTimeout(() => recentlyProcessed.delete(cacheKey), 30_000);

  try {
    const account = await prisma.channelAccount.findFirst({
      where: {
        channelType:       "MERCADO_LIVRE",
        externalAccountId: String(user_id),
        initialSyncDone:   true,
      },
    });

    if (!account) {
      console.log(`[Webhook][ML] Conta ${user_id} não encontrada ou backfill pendente`);
      return;
    }

    console.log(`[Webhook][ML] Processando pedido ${orderId} para conta ${account.id}`);
    await syncEngine.processWebhook(account, { id: orderId });

  } catch (err: any) {
    console.error(`[Webhook][ML] Erro:`, err?.message);
  }
});

// GET para validação do ML
router.get("/ml", (req, res) => {
  res.sendStatus(200);
});

export default router;