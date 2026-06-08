import { Router } from "express";
import prisma from "../lib/prisma";
import { getValidToken, getMlClient } from "../lib/ml";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

export async function syncOrdersForUser(userId: number) {
  const tokens = await prisma.token.findMany({ where: { userId } });
  const results = [];

  for (const token of tokens) {
    const start = Date.now();
    let ordersNew = 0;
    let ordersUpdated = 0;
    let errorMessage: string | null = null;
    let status = "success";

    try {
      const validToken = await getValidToken(token.id);
      const mlClient = getMlClient(validToken.accessToken);

      // Busca mlUserId se não estiver salvo
      let sellerId = validToken.mlUserId;
      if (!sellerId) {
        const meRes = await mlClient.get("/users/me");
        sellerId = String(meRes.data.id);
        await prisma.token.update({
          where: { id: validToken.id },
          data: { mlUserId: sellerId, mlNickname: meRes.data.nickname },
        });
      }

      // Paginação — busca todos os pedidos sem limite
      let offset = 0;
      const pageSize = 50;
      let hasMore = true;

      while (hasMore) {
        const mlRes = await mlClient.get("/orders/search", {
          params: {
            seller: sellerId,
            sort: "date_desc",
            limit: pageSize,
            offset,
          },
        });

        const mlOrders = mlRes.data.results ?? [];
        const total = mlRes.data.paging?.total ?? 0;

        for (const mlOrder of mlOrders) {
          const existing = await prisma.order.findUnique({
            where: { mlId: String(mlOrder.id) },
          });

          const orderData = {
            status: mlOrder.status,
            totalAmount: mlOrder.total_amount,
            netReceived: mlOrder.payments?.[0]?.total_paid_amount ?? null,
            dateCreated: new Date(mlOrder.date_created),
            userId,
            tokenId: token.id,
          };

          if (!existing) {
            const created = await prisma.order.create({
              data: { mlId: String(mlOrder.id), ...orderData },
            });

            for (const item of mlOrder.order_items ?? []) {
              await prisma.item.create({
  data: {
    orderId: created.id,
    mlItemId: String(item.item?.id ?? ""),
    title: item.item?.title ?? "—",
    quantity: item.quantity,
    unitPrice: item.unit_price,
    sku: item.item?.seller_sku ?? null,
    saleFee: item.sale_fee ?? 0,
  },
});
            }

            for (const pay of mlOrder.payments ?? []) {
              await prisma.payment.create({
                data: {
                  orderId: created.id,
                  mlPaymentId: String(pay.id),
                  status: pay.status,
                  totalPaidAmount: pay.total_paid_amount ?? 0,
                  taxesAmount: pay.taxes_amount ?? 0,
                  operationType: pay.operation_type ?? "regular_payment",
                },
              });
            }

if (mlOrder.shipping?.id) {
  // Busca o custo real do frete
  let shippingCost: number | null = null;
  try {
    const shipRes = await mlClient.get(
      `/shipments/${mlOrder.shipping.id}/costs`
    );
    shippingCost = shipRes.data?.shipping_fee ?? 
                   shipRes.data?.cost ?? 
                   null;
  } catch {
    shippingCost = null;
  }

  await prisma.shipment.upsert({
    where: { orderId: created.id },
    create: {
      orderId: created.id,
      mlShipmentId: String(mlOrder.shipping.id),
      status: mlOrder.shipping.status ?? "pending",
      trackingNumber: mlOrder.shipping.tracking_number ?? null,
      cost: shippingCost,
      dateCreated: new Date(mlOrder.date_created),
    },
    update: { cost: shippingCost },
  });
}
            ordersNew++;
          } else {
            await prisma.order.update({
              where: { id: existing.id },
              data: orderData,
            });
            ordersUpdated++;
          }
        }

        offset += pageSize;
        hasMore = mlOrders.length === pageSize && offset < total;
      }
    } catch (err: any) {
      status = "failed";
      errorMessage = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err?.message ?? "Sync error";
    }

    const durationMs = Date.now() - start;
    await prisma.syncLog.create({
      data: {
        userId, tokenId: token.id, status,
        ordersNew, ordersUpdated, errorMessage, durationMs,
      },
    });
    results.push({ tokenId: token.id, status, ordersNew, ordersUpdated, errorMessage });
  }

  await prisma.user.update({ where: { id: userId }, data: { lastSyncAt: new Date() } });
  return results;
}

// GET /orders/sync
router.get("/", requireAuth, requireFuncionarioPermission("sync_ml"), async (req, res) => {
  const user = req.user;
  const liderId = await getLiderId(user);
  const results = await syncOrdersForUser(liderId);
  return res.json({ ok: true, results });
});

// GET /sync/status
router.get("/status", requireAuth, async (req, res) => {
  const user = req.user;
  const liderId = await getLiderId(user);
  const lider = await prisma.user.findUnique({
    where: { id: liderId },
    select: { lastSyncAt: true },
  });
  return res.json({ lastSyncAt: lider?.lastSyncAt });
});

// GET /orders/sync/preview (Premium only)
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

  return res.json({
    new: newCount, updated: updatedCount,
    unchanged: unchangedCount, orders: mlOrders.slice(0, 5),
  });
});

export default router;