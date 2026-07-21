import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission, requirePlan } from "../middlewares/auth";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

// ─── HELPER: monta o objeto de order compatível com o frontend ───────────────
function buildOrderResponse(order: any, profit: any, canViewProfit: boolean) {
  const base = {
    ...order,
    mlId:  order.mlId ?? order.externalOrderId,
    token: {
      apelido:    order.channelAccount?.apelido ?? order.channelAccount?.externalNickname ?? null,
      mlNickname: order.channelAccount?.externalNickname ?? null,
    },
    missingSkus: (order.items ?? []).filter((i: any) => !i.sku).map((i: any) => i.title),
  };

  if (!canViewProfit || !profit) {
    return { ...base, profit: null, margin: null, allCostsFound: true };
  }

  return {
    ...base,
    profit:       Math.round(profit.profit       * 100) / 100,
    margin:       profit.margin,
    mlFee:        Math.round(profit.mlFee        * 100) / 100,
    shippingCost: Math.round(profit.shippingCost * 100) / 100,
    mlTax:        Math.round(profit.mlTax        * 100) / 100,
    nfTax:        Math.round(profit.nfTax        * 100) / 100,
    productCost:  Math.round(profit.productCost  * 100) / 100,
    estorno:      Math.round(profit.estorno      * 100) / 100,
    allCostsFound: profit.allCostsFound,
  };
}

// ─── HELPER: monta o WHERE a partir de todos os filtros ──────────────────────
function buildWhere(q: Record<string, string>, liderId: number) {
  const {
    search, status,
    dateFrom, dateTo,
    releaseFrom, releaseTo, released,
    amountMin, amountMax,
    shippingMin, shippingMax,
    channelType, channelAccountId,
    sku, itemCount, isPack,
    shipmentStatus, hasTracking,
    state, city, docType,
  } = q;

  const where: any = { userId: liderId };

  // ── Status do pedido ──────────────────────────────────────────────────────
  if (status) {
    const list = status.split(",").map((s) => s.trim()).filter(Boolean);
    where.status = list.length > 1 ? { in: list } : list[0];
  }

  // ── Busca livre: ID, produto, comprador, documento ────────────────────────
  if (search) {
    const term = search.trim();
    const digits = term.replace(/\D/g, "");
    where.OR = [
      { externalOrderId: { contains: term, mode: "insensitive" } },
      { mlId:            { contains: term, mode: "insensitive" } },
      { packId:          { contains: term, mode: "insensitive" } },
      { buyerName:       { contains: term, mode: "insensitive" } },
      { items: { some: { title: { contains: term, mode: "insensitive" } } } },
      { items: { some: { sku:   { contains: term, mode: "insensitive" } } } },
      ...(digits.length >= 3
        ? [{ buyerDocNumber: { contains: digits, mode: "insensitive" as const } }]
        : []),
    ];
  }

  // ── Data da venda ─────────────────────────────────────────────────────────
  if (dateFrom || dateTo) {
    where.dateCreated = {};
    if (dateFrom) where.dateCreated.gte = new Date(dateFrom);
    if (dateTo)   where.dateCreated.lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
  }

  // ── Data de liberação (Payment.moneyReleaseDate) ──────────────────────────
  const paymentFilter: any = {};
  if (releaseFrom || releaseTo) {
    paymentFilter.moneyReleaseDate = {};
    if (releaseFrom) paymentFilter.moneyReleaseDate.gte = new Date(releaseFrom);
    if (releaseTo)   paymentFilter.moneyReleaseDate.lte = new Date(new Date(releaseTo).setHours(23, 59, 59, 999));
  }
  if (Object.keys(paymentFilter).length > 0) {
    where.payments = { some: paymentFilter };
  }

  // ── Já liberado / a liberar ───────────────────────────────────────────────
  if (released === "yes") {
    where.payments = { some: { ...paymentFilter, moneyReleaseDate: { lte: new Date() } } };
  } else if (released === "no") {
    where.payments = {
      some: {
        OR: [{ moneyReleaseDate: null }, { moneyReleaseDate: { gt: new Date() } }],
      },
    };
  }

  // ── Faixa de receita ──────────────────────────────────────────────────────
  if (amountMin || amountMax) {
    where.totalAmount = {};
    if (amountMin) where.totalAmount.gte = parseFloat(amountMin);
    if (amountMax) where.totalAmount.lte = parseFloat(amountMax);
  }

  // ── Faixa de frete ────────────────────────────────────────────────────────
  if (shippingMin || shippingMax) {
    where.shippingCost = {};
    if (shippingMin) where.shippingCost.gte = parseFloat(shippingMin);
    if (shippingMax) where.shippingCost.lte = parseFloat(shippingMax);
  }

  // ── Canal e conta ─────────────────────────────────────────────────────────
  if (channelType)      where.channelType      = channelType;
  if (channelAccountId) where.channelAccountId = channelAccountId;

  // ── Produto ───────────────────────────────────────────────────────────────
  if (sku) {
    const list = sku.split(",").map((s) => s.trim()).filter(Boolean);
    where.items = { some: { sku: list.length > 1 ? { in: list } : list[0] } };
  }

  // ── Pedido de carrinho ────────────────────────────────────────────────────
  if (isPack === "yes") where.packId = { not: null };
  if (isPack === "no")  where.packId = null;

  // ── Envio ─────────────────────────────────────────────────────────────────
  const shipmentFilter: any = {};
  if (shipmentStatus) {
    const list = shipmentStatus.split(",").map((s) => s.trim()).filter(Boolean);
    shipmentFilter.status = list.length > 1 ? { in: list } : list[0];
  }
  if (hasTracking === "yes") shipmentFilter.trackingNumber = { not: null };
  if (hasTracking === "no")  shipmentFilter.trackingNumber = null;
  if (Object.keys(shipmentFilter).length > 0) where.shipment = shipmentFilter;

  // ── Comprador ─────────────────────────────────────────────────────────────
  if (state) {
    const list = state.split(",").map((s) => s.trim()).filter(Boolean);
    where.buyerState = list.length > 1 ? { in: list } : list[0];
  }
  if (city)    where.buyerCity   = { contains: city, mode: "insensitive" };
  if (docType) where.buyerDocType = docType;

  return { where, itemCount };
}

// ─── GET /orders/filter-options ──────────────────────────────────────────────
// Alimenta os selects do painel de filtros
router.get("/filter-options", requireAuth, async (req, res) => {
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const [states, accounts, skus, shipmentStatuses] = await Promise.all([
    prisma.order.findMany({
      where:    { userId: liderId, buyerState: { not: null } },
      select:   { buyerState: true },
      distinct: ["buyerState"],
      orderBy:  { buyerState: "asc" },
    }),
    prisma.channelAccount.findMany({
      where:  { userId: liderId },
      select: { id: true, apelido: true, externalNickname: true, channelType: true },
    }),
    prisma.productCost.findMany({
      where:    { userId: liderId },
      select:   { sku: true },
      distinct: ["sku"],
      orderBy:  { sku: "asc" },
      take:     500,
    }),
    prisma.shipment.findMany({
      where:    { order: { userId: liderId } },
      select:   { status: true },
      distinct: ["status"],
    }),
  ]);

  return res.json({
    states:   states.map((s) => s.buyerState).filter(Boolean),
    accounts: accounts.map((a) => ({
      id:          a.id,
      label:       a.apelido ?? a.externalNickname ?? a.id,
      channelType: a.channelType,
    })),
    skus:             skus.map((s) => s.sku),
    shipmentStatuses: shipmentStatuses.map((s) => s.status).filter(Boolean),
  });
});

// ─── GET /orders ─────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireFuncionarioPermission("view_orders"), async (req, res) => {
  const q = req.query as Record<string, string>;
  const {
    page = "1", limit = "50",
    sortField = "dateCreated", sortDir = "desc",
    onlyMissingCost,
  } = q;

  const liderId       = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
  const canViewProfit = req.user.role === "admin" || req.user.subscription?.plan?.canViewProfit;

  const { where, itemCount } = buildWhere(q, liderId);

  const pageNum  = parseInt(page);
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const skip     = (pageNum - 1) * limitNum;

  const validSortFields = ["externalOrderId", "totalAmount", "dateCreated", "status", "shippingCost"];
  const orderBy: any    = validSortFields.includes(sortField)
    ? { [sortField]: sortDir === "asc" ? "asc" : "desc" }
    : { dateCreated: "desc" };

  const includeFields = {
    items:          true,
    payments:       true,
    shipment:       true,
    channelAccount: { select: { apelido: true, externalNickname: true, channelType: true } },
  };

  // ── SKUs com custo cadastrado (usado pelo badge e pelo filtro) ────────────
  const registeredCosts = canViewProfit
    ? await prisma.productCost.findMany({
        where: { userId: liderId }, select: { sku: true }, distinct: ["sku"],
      })
    : [];
  const registeredSkuSet = new Set(registeredCosts.map((c) => c.sku));

  // ── Filtro "sem custo cadastrado" ─────────────────────────────────────────
  if (onlyMissingCost === "true" && canViewProfit) {
    const candidates = await prisma.order.findMany({
      where,
      select: { id: true, items: { select: { sku: true } } },
    });
    const missingIds = candidates
      .filter((o) => o.items.some((i) => !i.sku || !registeredSkuSet.has(i.sku)))
      .map((o) => o.id);
    where.id = { in: missingIds };
  }

  // ── Busca ─────────────────────────────────────────────────────────────────
  let total  = await prisma.order.count({ where });
  let orders = await prisma.order.findMany({
    where, include: includeFields, orderBy, skip, take: limitNum,
  });

  // ── Filtro por nº de itens (pós-query — Prisma não conta relação em where) ─
  if (itemCount === "single" || itemCount === "multi") {
    orders = orders.filter((o) => {
      const qty = o.items.reduce((acc, i) => acc + i.quantity, 0);
      return itemCount === "single" ? qty === 1 : qty > 1;
    });
  }

  const ordersWithProfit = await Promise.all(
    orders.map(async (order) => {
      if (!canViewProfit) return buildOrderResponse(order, null, false);
      const p = await calculateOrderProfit(order.id);
      return buildOrderResponse(order, p, canViewProfit);
    })
  );

  // ── Badge de pedidos sem custo (global, ignora filtros) ───────────────────
  let missingCostTotal = 0;
  if (canViewProfit) {
    const allOrders = await prisma.order.findMany({
      where:  { userId: liderId },
      select: { id: true, items: { select: { sku: true } } },
    });
    missingCostTotal = allOrders.filter((o) =>
      o.items.some((i) => !i.sku || !registeredSkuSet.has(i.sku))
    ).length;
  }

  return res.json({
    orders: ordersWithProfit,
    total,
    page:       pageNum,
    limit:      limitNum,
    totalPages: Math.ceil(total / limitNum),
    missingCostTotal,
  });
});

// ─── GET /orders/by-shipment/:shipmentId ─────────────────────────────────────
router.get("/by-shipment/:shipmentId", requireAuth, async (req, res) => {
  const liderId       = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
  const canViewProfit = req.user.role === "admin" || req.user.subscription?.plan?.canViewProfit;

  const shipment = await prisma.shipment.findFirst({
    where: { externalShipmentId: req.params.shipmentId },
    include: {
      order: {
        include: {
          items:          true,
          payments:       true,
          channelAccount: { select: { apelido: true, externalNickname: true, channelType: true } },
        },
      },
    },
  });

  if (!shipment || shipment.order.userId !== liderId) {
    return res.status(404).json({ message: "Pedido não encontrado" });
  }

  const order = shipment.order;
  const p     = canViewProfit ? await calculateOrderProfit(order.id) : null;

  return res.json({ order: buildOrderResponse(order, p, canViewProfit) });
});

// ─── GET /profit ─────────────────────────────────────────────────────────────
router.get("/profit", requireAuth, requirePlan("prata"), requireFuncionarioPermission("view_profit"), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const where: any = { userId: liderId };
  if (from) where.dateCreated = { ...where.dateCreated, gte: new Date(from) };
  if (to)   where.dateCreated = { ...where.dateCreated, lte: new Date(to) };

  const orders = await prisma.order.findMany({
    where,
    include: {
      items:          true,
      payments:       true,
      channelAccount: { select: { apelido: true, externalNickname: true } },
    },
    orderBy: { dateCreated: "desc" },
    take:    500,
  });

  const result = await Promise.all(
    orders.map(async (o) => {
      const profit = await calculateOrderProfit(o.id);
      return {
        ...o,
        mlId:  o.mlId ?? o.externalOrderId,
        token: { apelido: o.channelAccount?.apelido ?? o.channelAccount?.externalNickname ?? null },
        ...profit,
      };
    })
  );

  return res.json({ orders: result });
});

export default router;