import { Router } from "express";
import prisma from "../lib/prisma";
import { syncEngine } from "../sync/SyncEngine";

const router = Router();

router.post("/ml", async (req, res) => {
  // Responde imediatamente — ML exige resposta em < 500ms
  res.sendStatus(200);

  // Ignora requisições sem body válido (validações do ML)
  if (!req.body || typeof req.body !== "object") return;

  const { topic, resource, user_id } = req.body;

  if (topic !== "orders" && topic !== "orders_v2") return;
  if (!resource || !user_id) return;

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

    const orderId = String(resource).replace("/orders/", "").trim();
    if (!orderId || isNaN(Number(orderId))) return;

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