import { Router } from "express";
import prisma from "../lib/prisma";
import { syncEngine } from "../sync/SyncEngine";
import crypto from "crypto";

const router = Router();

// POST /webhooks/ml
// Recebe notificações em tempo real do ML (topic: orders_v2)
router.post("/ml", async (req, res) => {
  // Responde imediatamente — ML exige resposta em < 500ms
  res.sendStatus(200);

  const { topic, resource, user_id } = req.body;

  // Só processa notificações de pedidos
  if (topic !== "orders" && topic !== "orders_v2") return;

  try {
    // Busca a conta do ML pelo externalAccountId
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

    // Extrai o orderId do resource (formato: /orders/2000013459174881)
    const orderId = String(resource).replace("/orders/", "").trim();
    if (!orderId || isNaN(Number(orderId))) return;

    console.log(`[Webhook][ML] Processando pedido ${orderId} para conta ${account.id}`);
    await syncEngine.processWebhook(account, { id: orderId });

  } catch (err: any) {
    console.error(`[Webhook][ML] Erro:`, err?.message);
  }
});

export default router;