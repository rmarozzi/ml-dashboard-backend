// src/lib/syncEngine.ts
//
// Motor de sincronização de pedidos. Substitui a lógica que antes vivia
// inteira em src/routes/sync.ts. Três camadas:
//
//   Camada 0 (backfill)      — roda 1x por conta ML, na primeira conexão.
//                               Varre o histórico completo (mesma lógica de
//                               antes, semana a semana).
//   Camada 1 (incremental)   — roda a cada execução seguinte. Pergunta pro
//                               Mercado Livre "o que mudou desde X" via
//                               order.date_last_updated, em vez de revarrer
//                               tudo.
//   Camada 2 (assentamento)  — roda a cada execução seguinte. Rechecagem
//                               direcionada, no seu próprio banco, dos
//                               pedidos dos últimos SETTLEMENT_WINDOW_DAYS
//                               dias cujo envio ainda não chegou a um status
//                               final ou cujo pagamento ainda não tem data
//                               de liberação — cobre mudanças de envio/
//                               pagamento que não necessariamente atualizam
//                               o date_last_updated do pedido em si.
//
// Em todas as camadas, o pedido, os pagamentos e o envio são sempre
// upsertados (nunca só criados na primeira vez). Itens são criados apenas
// na primeira vez que um pedido é visto — na prática não mudam depois.

import prisma from "./prisma";
import { getValidToken, getMlClient } from "./ml";

// ─── Configuração ────────────────────────────────────────────────────────────
const SETTLEMENT_WINDOW_DAYS = 30; // janela de rechecagem, a partir da criação do pedido
const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000; // margem de segurança contra corte exato no timestamp
const SHIPMENT_TERMINAL_STATUSES = ["delivered", "not_delivered", "cancelled"];
const SYNC_CADENCE_MINUTES = 15;

// Trava simples em memória — evita dois syncs simultâneos pro mesmo usuário
const syncInProgress = new Set<number>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrapper com retry automático em caso de rate limit (429)
async function mlGetWithRetry(mlClient: any, url: string, options: any = {}, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    try {
      return await mlClient.get(url, options);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        attempt++;
        const waitMs = 1000 * Math.pow(2, attempt);
        console.log(`[sync] Rate limit (429) em ${url} — tentativa ${attempt}/${maxRetries}, aguardando ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

// ─── Enriquece e grava um pedido individual (upsert em Order + Payment + Shipment) ──
async function enrichAndUpsertOrder(
  mlClient: any,
  mlOrder: any,
  userId: number,
  tokenId: number,
  shipmentCache: Record<string, { status: string; tracking: string | null; cost: number | null; discount: number }>,
  shipmentOrderCount: Record<string, number>
): Promise<boolean> {
  let shippingCost: number | null = null;
  let shippingDiscount = 0;

  if (mlOrder.shipping?.id) {
    const shipId = String(mlOrder.shipping.id);

    if (!shipmentCache[shipId]) {
      let statusShip = "pending";
      let tracking: string | null = null;
      let cost: number | null = null;
      let discount = 0;

      try {
        const shipDetailRes = await mlGetWithRetry(mlClient, `/shipments/${shipId}`);
        statusShip = shipDetailRes.data?.status ?? "pending";
        tracking = shipDetailRes.data?.tracking_number ?? null;
      } catch {
        statusShip = mlOrder.shipping.status ?? "pending";
      }

      try {
        const shipCostsRes = await mlGetWithRetry(mlClient, `/shipments/${shipId}/costs`);
        const senders = shipCostsRes.data?.senders ?? [];
        const receiver = shipCostsRes.data?.receiver ?? {};
        cost = senders.length > 0 ? (senders[0].cost ?? null) : null;
        discount = receiver.save ?? 0;
      } catch {
        cost = null;
      }

      shipmentCache[shipId] = { status: statusShip, tracking, cost, discount };
    }

    const cached = shipmentCache[shipId];
    shippingDiscount = cached.discount;
    const orderCount = shipmentOrderCount[shipId] ?? 1;
    shippingCost = cached.cost != null ? cached.cost / orderCount : null;
  }

  const mlFee = (mlOrder.order_items ?? []).reduce(
    (acc: number, item: any) => acc + (item.sale_fee ?? 0), 0
  );
  const taxesAmount = mlOrder.taxes?.amount ?? 0;

  let buyerName: string | null = null;
  let buyerDocType: string | null = null;
  let buyerDocNumber: string | null = null;
  let buyerCity: string | null = null;
  let buyerState: string | null = null;

  try {
    const billingRes = await mlGetWithRetry(mlClient, `/orders/${mlOrder.id}/billing_info`);
    const info = billingRes.data?.billing_info?.additional_info ?? [];
    const getField = (type: string) => info.find((f: any) => f.type === type)?.value ?? null;

    const firstName = getField("FIRST_NAME");
    const lastName = getField("LAST_NAME");
    buyerName = [firstName, lastName].filter(Boolean).join(" ") || null;
    buyerDocType = getField("DOC_TYPE");
    buyerDocNumber = getField("DOC_NUMBER");
    buyerCity = getField("CITY_NAME");
    const stateCode = getField("STATE_CODE");
    buyerState = stateCode ? stateCode.replace("BR-", "") : null;
  } catch {
    // Billing info pode não estar disponível para todos os pedidos
  }

  const netReceived = mlOrder.total_amount - mlFee - (shippingCost ?? 0);

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
    tokenId,
  };

  // Upsert do pedido — substitui o find+create/update, elimina a corrida
  // de duas execuções concorrentes tentando criar o mesmo pedido.
  const order = await prisma.order.upsert({
    where: { mlId: String(mlOrder.id) },
    create: { mlId: String(mlOrder.id), ...orderData },
    update: orderData,
  });

  // Itens: só na primeira vez que este pedido é visto (não se espera que
  // título/sku/preço de item mudem depois da venda).
  const existingItemCount = await prisma.item.count({ where: { orderId: order.id } });
  const wasNew = existingItemCount === 0;

  if (wasNew) {
    for (const item of mlOrder.order_items ?? []) {
      await prisma.item.create({
        data: {
          orderId: order.id,
          mlItemId: String(item.item?.id ?? ""),
          title: item.item?.title ?? "—",
          quantity: item.quantity,
          unitPrice: item.unit_price,
          sku: item.item?.seller_sku ?? null,
          saleFee: item.sale_fee ?? 0,
        },
      });
    }
  }

  // Pagamentos — sempre upsert. Um estorno que aparece dias depois da venda
  // original agora é capturado, porque não dependemos mais de "criar só na
  // primeira vez". A busca da data de liberação do dinheiro só é refeita
  // se ainda não tivermos ela salva (evita chamada repetida ao Mercado
  // Pago pra pagamento que já assentou).
  const existingPayments = await prisma.payment.findMany({
    where: { orderId: order.id },
    select: { mlPaymentId: true, moneyReleaseDate: true },
  });
  const knownReleaseDates = new Map(existingPayments.map((p) => [p.mlPaymentId, p.moneyReleaseDate]));

  for (const pay of mlOrder.payments ?? []) {
    const mlPaymentId = String(pay.id);
    let moneyReleaseDate = knownReleaseDates.get(mlPaymentId) ?? null;

    if (!moneyReleaseDate) {
      try {
        const payDetailRes = await mlGetWithRetry(mlClient, `/v1/payments/${pay.id}`, {
          baseURL: "https://api.mercadopago.com",
        });
        moneyReleaseDate = payDetailRes.data?.money_release_date
          ? new Date(payDetailRes.data.money_release_date)
          : null;
      } catch {
        // Nem todo pagamento tem esse dado disponível
      }
    }

    const paymentData = {
      status: pay.status,
      totalPaidAmount: pay.total_paid_amount ?? 0,
      taxesAmount: pay.taxes_amount ?? 0,
      operationType: pay.operation_type ?? "regular_payment",
      paymentMethodId: pay.payment_method_id ?? null,
      moneyReleaseDate,
    };

    await prisma.payment.upsert({
      where: { mlPaymentId },
      create: { orderId: order.id, mlPaymentId, ...paymentData },
      update: paymentData,
    });
  }

  // Envio — sempre upsert (antes só era criado na primeira vez; agora
  // status/rastreio/custo se atualizam a cada passada).
  if (mlOrder.shipping?.id) {
    const cached = shipmentCache[String(mlOrder.shipping.id)];
    await prisma.shipment.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        mlShipmentId: String(mlOrder.shipping.id),
        status: cached?.status ?? "pending",
        trackingNumber: cached?.tracking ?? null,
        cost: shippingCost,
        dateCreated: new Date(mlOrder.date_created),
      },
      update: {
        status: cached?.status ?? "pending",
        trackingNumber: cached?.tracking ?? null,
        cost: shippingCost,
      },
    });
  }

  return wasNew;
}

// Processa um lote de pedidos já vindos do ML (de qualquer camada)
async function processOrderBatch(mlClient: any, mlOrders: any[], userId: number, tokenId: number) {
  const shipmentOrderCount: Record<string, number> = {};
  for (const o of mlOrders) {
    const shipId = o.shipping?.id;
    if (!shipId) continue;
    shipmentOrderCount[shipId] = (shipmentOrderCount[shipId] ?? 0) + 1;
  }
  const shipmentCache: Record<string, any> = {};

  let ordersNew = 0;
  let ordersUpdated = 0;

  for (const mlOrder of mlOrders) {
    const wasNew = await enrichAndUpsertOrder(mlClient, mlOrder, userId, tokenId, shipmentCache, shipmentOrderCount);
    if (wasNew) ordersNew++; else ordersUpdated++;
    await sleep(100);
  }

  return { ordersNew, ordersUpdated };
}

// ─── CAMADA 0: Backfill histórico completo (1x por conta ML) ────────────────
async function runInitialBackfill(mlClient: any, sellerId: string, userId: number, tokenId: number) {
  const oldestRes = await mlGetWithRetry(mlClient, "/orders/search", {
    params: { seller: sellerId, sort: "date_asc", limit: 1, offset: 0 },
  });
  const oldestOrder = oldestRes.data.results?.[0];
  const startDate = oldestOrder ? new Date(oldestOrder.date_created) : new Date();
  startDate.setHours(0, 0, 0, 0);

  console.log(`[sync] tokenId ${tokenId} — backfill inicial a partir de ${startDate.toISOString().slice(0, 10)}`);

  const pageSize = 50;
  const allMlOrders: any[] = [];
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  for (
    let weekStart = new Date(startDate);
    weekStart.getTime() <= Date.now();
    weekStart = new Date(weekStart.getTime() + oneWeekMs)
  ) {
    const weekEnd = new Date(Math.min(weekStart.getTime() + oneWeekMs - 1, Date.now()));
    let offset = 0;
    let hasMoreInWeek = true;

    while (hasMoreInWeek) {
      const mlRes = await mlGetWithRetry(mlClient, "/orders/search", {
        params: {
          seller: sellerId,
          limit: pageSize,
          offset,
          "order.date_created.from": weekStart.toISOString(),
          "order.date_created.to": weekEnd.toISOString(),
        },
      });
      const mlOrders = mlRes.data.results ?? [];
      const total = mlRes.data.paging?.total ?? 0;

      allMlOrders.push(...mlOrders);
      offset += pageSize;
      hasMoreInWeek = mlOrders.length === pageSize && offset < total;

      if (total > 9900) {
        console.log(`[sync] ALERTA tokenId ${tokenId} — semana de ${weekStart.toISOString().slice(0, 10)} tem ${total} pedidos, perto do limite de 10k!`);
      }
      if (hasMoreInWeek) await sleep(300);
    }
    await sleep(150);
  }

  const result = await processOrderBatch(mlClient, allMlOrders, userId, tokenId);

  console.log(`[sync] tokenId ${tokenId} — backfill concluído (${result.ordersNew} novos, ${result.ordersUpdated} atualizados). Gravando initialSyncDone...`);
  try {
    const updated = await prisma.token.update({
      where: { id: tokenId },
      data: { initialSyncDone: true, lastSyncAt: new Date() },
    });
    console.log(`[sync] tokenId ${tokenId} — gravado: initialSyncDone=${updated.initialSyncDone}, lastSyncAt=${updated.lastSyncAt?.toISOString()}`);
  } catch (err: any) {
    console.error(`[sync] tokenId ${tokenId} — FALHA ao gravar initialSyncDone:`, err?.message ?? err);
    throw err;
  }

  return result;
}

// ─── CAMADA 1: Descoberta incremental via order.date_last_updated ──────────
async function runIncrementalDiscovery(mlClient: any, sellerId: string, userId: number, tokenId: number, since: Date) {
  const from = new Date(since.getTime() - INCREMENTAL_OVERLAP_MS);
  const pageSize = 50;
  let offset = 0;
  let hasMore = true;
  const allMlOrders: any[] = [];

  while (hasMore) {
    const mlRes = await mlGetWithRetry(mlClient, "/orders/search", {
      params: {
        seller: sellerId,
        limit: pageSize,
        offset,
        "order.date_last_updated.from": from.toISOString(),
        "order.date_last_updated.to": new Date().toISOString(),
      },
    });
    const mlOrders = mlRes.data.results ?? [];
    const total = mlRes.data.paging?.total ?? 0;
    allMlOrders.push(...mlOrders);
    offset += pageSize;
    hasMore = mlOrders.length === pageSize && offset < total;
    if (hasMore) await sleep(300);
  }

  if (allMlOrders.length > 0) {
    console.log(`[sync] tokenId ${tokenId} — descoberta incremental: ${allMlOrders.length} pedido(s) com mudança desde ${from.toISOString()}`);
  }

  return processOrderBatch(mlClient, allMlOrders, userId, tokenId);
}

// ─── CAMADA 2: Rechecagem de pedidos ainda não assentados (envio/pagamento) ─
async function runSettlementRecheck(mlClient: any, userId: number, tokenId: number) {
  const windowStart = new Date(Date.now() - SETTLEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await prisma.order.findMany({
    where: {
      tokenId,
      dateCreated: { gte: windowStart },
      OR: [
        { shipment: null },
        { shipment: { status: { notIn: SHIPMENT_TERMINAL_STATUSES } } },
        { payments: { some: { moneyReleaseDate: null } } },
      ],
    },
    select: { mlId: true },
  });

  if (candidates.length === 0) return { ordersNew: 0, ordersUpdated: 0 };

  console.log(`[sync] tokenId ${tokenId} — rechecagem de assentamento: ${candidates.length} pedido(s) ainda em aberto na janela de ${SETTLEMENT_WINDOW_DAYS} dias`);

  const freshOrders: any[] = [];
  for (const c of candidates) {
    try {
      const res = await mlGetWithRetry(mlClient, `/orders/${c.mlId}`);
      freshOrders.push(res.data);
    } catch (err: any) {
      console.error(`[sync] Falha ao rechecar pedido ${c.mlId}:`, err?.message);
    }
    await sleep(100);
  }

  return processOrderBatch(mlClient, freshOrders, userId, tokenId);
}

// ─── Orquestração por usuário (mesma assinatura pública de antes) ──────────
export async function syncOrdersForUser(userId: number) {
  if (syncInProgress.has(userId)) {
    console.log(`[sync] Sync já em andamento para userId ${userId} — ignorando chamada duplicada`);
    return [{ tokenId: null, status: "skipped", ordersNew: 0, ordersUpdated: 0, errorMessage: "Sync já em andamento" }];
  }
  syncInProgress.add(userId);

  try {
    const tokens = await prisma.token.findMany({ where: { userId } });
    const results = [];

    for (const token of tokens) {
      const start = Date.now();
      let ordersNew = 0;
      let ordersUpdated = 0;
      let errorMessage: string | null = null;
      let status = "success";

      // Marca início — permite consultar "está rodando agora?" via /sync/status,
      // sem depender de logs. Se o processo morrer no meio (deploy, crash), isso
      // fica "preso" e o /sync/status classifica como "stalled" depois de um tempo.
      await prisma.token.update({ where: { id: token.id }, data: { syncStartedAt: new Date() } }).catch(() => {});

      try {
        const validToken = await getValidToken(token.id);
        const mlClient = getMlClient(validToken.accessToken);

        let sellerId = validToken.mlUserId;
        if (!sellerId) {
          const meRes = await mlGetWithRetry(mlClient, "/users/me");
          sellerId = String(meRes.data.id);
          await prisma.token.update({
            where: { id: validToken.id },
            data: { mlUserId: sellerId, mlNickname: meRes.data.nickname },
          });
        }

        if (!validToken.initialSyncDone) {
          const r = await runInitialBackfill(mlClient, sellerId, userId, token.id);
          ordersNew = r.ordersNew;
          ordersUpdated = r.ordersUpdated;
        } else {
          const since = validToken.lastSyncAt ?? new Date(0);
          const r1 = await runIncrementalDiscovery(mlClient, sellerId, userId, token.id, since);
          const r2 = await runSettlementRecheck(mlClient, userId, token.id);
          ordersNew = r1.ordersNew + r2.ordersNew;
          ordersUpdated = r1.ordersUpdated + r2.ordersUpdated;
          await prisma.token.update({ where: { id: token.id }, data: { lastSyncAt: new Date() } });
        }
      } catch (err: any) {
        status = "failed";
        errorMessage = err?.response?.data
          ? JSON.stringify(err.response.data)
          : err?.message ?? "Sync error";
      }

      // Limpa a marcação de início — o processamento desse token terminou
      // (com sucesso ou falha tratada). Se isso não rodar (processo morto no
      // meio), o campo fica "preso" propositalmente, para ser detectado como
      // "stalled" pelo /sync/status.
      await prisma.token.update({ where: { id: token.id }, data: { syncStartedAt: null } }).catch(() => {});

      const durationMs = Date.now() - start;
      await prisma.syncLog.create({
        data: { userId, tokenId: token.id, status, ordersNew, ordersUpdated, errorMessage, durationMs },
      });
      results.push({ tokenId: token.id, status, ordersNew, ordersUpdated, errorMessage });
    }

    await prisma.user.update({ where: { id: userId }, data: { lastSyncAt: new Date() } });
    return results;
  } finally {
    syncInProgress.delete(userId);
  }
}

export { mlGetWithRetry, SYNC_CADENCE_MINUTES };