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

// ── 1ª passada: coleta todos os pedidos de todas as páginas ─────────────
      let offset = 0;
      const pageSize = 50;
      let hasMore = true;
      const allMlOrders: any[] = [];

      while (hasMore) {
        const mlRes = await mlClient.get("/orders/search", {
          params: { seller: sellerId, sort: "date_desc", limit: pageSize, offset },
        });

        const mlOrders = mlRes.data.results ?? [];
        const total = mlRes.data.paging?.total ?? 0;
        allMlOrders.push(...mlOrders);

        offset += pageSize;
        hasMore = mlOrders.length === pageSize && offset < total;
      }

      // ── Agrupa pedidos por shipment (mesmo shipping.id = mesmo pack) ────────
      const shipmentOrderCount: Record<string, number> = {};
      for (const o of allMlOrders) {
        const shipId = o.shipping?.id;
        if (!shipId) continue;
        shipmentOrderCount[shipId] = (shipmentOrderCount[shipId] ?? 0) + 1;
      }

      // Cache pra não buscar o mesmo shipment várias vezes
      const shipmentCache: Record<string, { status: string; tracking: string | null; cost: number | null; discount: number }> = {};

      // ── 2ª passada: processa cada pedido individualmente ─────────────────────
      {
        for (const mlOrder of allMlOrders) {
          // Custo do frete via endpoint separado (com cache + rateio por pack)
          let shippingCost: number | null = null;
          let shippingDiscount = 0;
          let shippingStatus = "pending";
          let trackingNumber: string | null = null;

          if (mlOrder.shipping?.id) {
            const shipId = String(mlOrder.shipping.id);

            if (!shipmentCache[shipId]) {
              let status = "pending";
              let tracking: string | null = null;
              let cost: number | null = null;
              let discount = 0;

              try {
                const shipDetailRes = await mlClient.get(`/shipments/${shipId}`);
                status = shipDetailRes.data?.status ?? "pending";
                tracking = shipDetailRes.data?.tracking_number ?? null;
              } catch {
                status = mlOrder.shipping.status ?? "pending";
              }

              try {
                const shipCostsRes = await mlClient.get(`/shipments/${shipId}/costs`);
                const senders = shipCostsRes.data?.senders ?? [];
                const receiver = shipCostsRes.data?.receiver ?? {};
                cost = senders.length > 0 ? (senders[0].cost ?? null) : null;
                discount = receiver.save ?? 0;
              } catch {
                cost = null;
              }

              shipmentCache[shipId] = { status, tracking, cost, discount };
            }

            const cached = shipmentCache[shipId];
            shippingStatus = cached.status;
            trackingNumber = cached.tracking;
            shippingDiscount = cached.discount;

            // Rateia o custo do frete entre os pedidos do mesmo pack
            const orderCount = shipmentOrderCount[shipId] ?? 1;
            shippingCost = cached.cost != null ? cached.cost / orderCount : null;
          }

          // Tarifa ML = soma dos sale_fee dos itens
          const mlFee = (mlOrder.order_items ?? []).reduce(
            (acc: number, item: any) => acc + (item.sale_fee ?? 0), 0
          );

          // Imposto NF
          const taxesAmount = mlOrder.taxes?.amount ?? 0;

// Busca dados do comprador (nome, documento, localização)
let buyerName: string | null = null;
let buyerDocType: string | null = null;
let buyerDocNumber: string | null = null;
let buyerCity: string | null = null;
let buyerState: string | null = null;

try {
  const billingRes = await mlClient.get(`/orders/${mlOrder.id}/billing_info`);
  const info = billingRes.data?.billing_info?.additional_info ?? [];
  const getField = (type: string) => info.find((f: any) => f.type === type)?.value ?? null;

  const firstName = getField("FIRST_NAME");
  const lastName = getField("LAST_NAME");
  buyerName = [firstName, lastName].filter(Boolean).join(" ") || null;
  buyerDocType = getField("DOC_TYPE");
  buyerDocNumber = getField("DOC_NUMBER");
  buyerCity = getField("CITY_NAME");
  const stateCode = getField("STATE_CODE"); // ex: "BR-SP"
  buyerState = stateCode ? stateCode.replace("BR-", "") : null;
} catch {
  // Billing info pode não estar disponível para todos os pedidos
}

          // Valor líquido recebido = total - tarifa - frete
          const netReceived = mlOrder.total_amount - mlFee - (shippingCost ?? 0);

          const existing = await prisma.order.findUnique({
            where: { mlId: String(mlOrder.id) },
          });

const orderData = {
  status: mlOrder.status,
  totalAmount: mlOrder.total_amount,
  netReceived,
  taxesAmount,
  shippingCost,
  dateCreated: new Date(mlOrder.date_created),
  userId,
  shippingDiscount,
  packId: mlOrder.pack_id ? String(mlOrder.pack_id) : null,
  buyerName,
  buyerDocType,
  buyerDocNumber,
  buyerCity,
  buyerState,
  tokenId: token.id,
};

          if (!existing) {
            const created = await prisma.order.create({
              data: { mlId: String(mlOrder.id), ...orderData },
            });

            // Itens com sale_fee
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

            // Pagamentos (estornos incluídos)
            for (const pay of mlOrder.payments ?? []) {
  // Busca a data de liberação do dinheiro via Mercado Pago
  let moneyReleaseDate: Date | null = null;
  try {
    const payDetailRes = await mlClient.get(`/v1/payments/${pay.id}`, {
      baseURL: "https://api.mercadopago.com",
    });
    moneyReleaseDate = payDetailRes.data?.money_release_date
      ? new Date(payDetailRes.data.money_release_date)
      : null;
  } catch {
    // Nem todo pagamento tem esse dado disponível
  }

  await prisma.payment.create({
    data: {
      orderId: created.id,
      mlPaymentId: String(pay.id),
      status: pay.status,
      totalPaidAmount: pay.total_paid_amount ?? 0,
      taxesAmount: pay.taxes_amount ?? 0,
      operationType: pay.operation_type ?? "regular_payment",
      paymentMethodId: pay.payment_method_id ?? null,
      moneyReleaseDate,
    },
  });
}

// Envio com status real e custo
            if (mlOrder.shipping?.id) {
              await prisma.shipment.upsert({
                where: { orderId: created.id },
                create: {
                  orderId: created.id,
                  mlShipmentId: String(mlOrder.shipping.id),
                  status: shippingStatus,
                  trackingNumber: trackingNumber,
                  cost: shippingCost,
                  dateCreated: new Date(mlOrder.date_created),
                },
                update: {
                  status: shippingStatus,
                  trackingNumber: trackingNumber,
                  cost: shippingCost,
                },
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

}
      }
    } catch (err: any) {

      status = "failed";
      errorMessage = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err?.message ?? "Sync error";
    }

    const durationMs = Date.now() - start;
    await prisma.syncLog.create({
      data: { userId, tokenId: token.id, status, ordersNew, ordersUpdated, errorMessage, durationMs },
    });
    results.push({ tokenId: token.id, status, ordersNew, ordersUpdated, errorMessage });
  }

  await prisma.user.update({ where: { id: userId }, data: { lastSyncAt: new Date() } });
  return results;
}

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

  return res.json({ new: newCount, updated: updatedCount, unchanged: unchangedCount, orders: mlOrders.slice(0, 5) });
});

export default router;