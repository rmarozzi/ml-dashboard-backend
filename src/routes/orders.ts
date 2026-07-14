import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission, requirePlan } from "../middlewares/auth";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

// ─── HELPER: monta o objeto de order com campos compatíveis com o frontend ────
function buildOrderResponse(order: any, profit: any, canViewProfit: boolean) {
  const base = {
    ...order,
    // ✅ mlId: usa packId para carrinhos, externalOrderId para pedidos simples
    // compatível com o frontend que usa: order.packId || order.mlId
    mlId:    order.mlId ?? order.externalOrderId,
    token:   {
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
    profit:      Math.round(profit.profit      * 100) / 100,
    margin:      profit.margin,
    mlFee:       Math.round(profit.mlFee       * 100) / 100,
    shippingCost:Math.round(profit.shippingCost* 100) / 100,
    mlTax:       Math.round(profit.mlTax       * 100) / 100,
    nfTax:       Math.round(profit.nfTax       * 100) / 100,
    productCost: Math.round(profit.productCost * 100) / 100,
    estorno:     Math.round(profit.estorno     * 100) / 100,
    allCostsFound: profit.allCostsFound,
  };
}

// ─── GET /orders ─────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireFuncionarioPermission("view_orders"), async (req, res) => {
  const {
    search, status, page = "1", limit = "50",
    sortField = "dateCreated", sortDir = "desc",
    onlyMissingCost,
  } = req.query as Record<string, string>;

  const liderId       = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
  const canViewProfit = req.user.role === "admin" || req.user.subscription?.plan?.canViewProfit;

  const where: any = { userId: liderId };
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { externalOrderId: { contains: search, mode: "insensitive" } },
      { mlId:            { contains: search, mode: "insensitive" } },
      { packId:          { contains: search, mode: "insensitive" } },
      { items: { some: { title: { contains: search, mode: "insensitive" } } } },
    ];
  }

  const pageNum  = parseInt(page);
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const skip     = (pageNum - 1) * limitNum;

  const validSortFields = ["externalOrderId", "totalAmount", "dateCreated", "status"];
  const orderBy: any    = validSortFields.includes(sortField)
    ? { [sortField]: sortDir === "asc" ? "asc" : "desc" }
    : { dateCreated: "desc" };

  const includeFields = {
    items:          true,
    payments:       true,
    channelAccount: { select: { apelido: true, externalNickname: true, channelType: true } },
  };

  // ── Filtro "sem custo cadastrado" ────────────────────────────────────────────
  if (onlyMissingCost === "true" && canViewProfit) {
    const candidateOrders = await prisma.order.findMany({
      where,
      select: { id: true, items: { select: { sku: true } } },
    });

    const registeredCosts = await prisma.productCost.findMany({
      where: { userId: liderId }, select: { sku: true }, distinct: ["sku"],
    });
    const registeredSkuSet  = new Set(registeredCosts.map((c) => c.sku));
    const missingCostIds    = candidateOrders
      .filter((o) => o.items.some((i) => !i.sku || !registeredSkuSet.has(i.sku)))
      .map((o) => o.id);
    const missingCostTotal  = missingCostIds.length;

    where.id = { in: missingCostIds };

    const orders = await prisma.order.findMany({
      where, include: includeFields, orderBy, skip, take: limitNum,
    });

    const ordersWithProfit = await Promise.all(
      orders.map(async (order) => {
        const p = await calculateOrderProfit(order.id);
        return buildOrderResponse(order, p, canViewProfit);
      })
    );

    return res.json({
      orders: ordersWithProfit,
      total: missingCostTotal,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(missingCostTotal / limitNum),
      missingCostTotal,
    });
  }

  // ── Fluxo normal ─────────────────────────────────────────────────────────────
  const total  = await prisma.order.count({ where });
  const orders = await prisma.order.findMany({
    where, include: includeFields, orderBy, skip, take: limitNum,
  });

  const ordersWithProfit = await Promise.all(
    orders.map(async (order) => {
      if (!canViewProfit) return buildOrderResponse(order, null, false);
      const p = await calculateOrderProfit(order.id);
      return buildOrderResponse(order, p, canViewProfit);
    })
  );

  // Badge de pedidos sem custo
  let missingCostTotal = 0;
  if (canViewProfit) {
    const allOrders = await prisma.order.findMany({
      where: { userId: liderId },
      select: { id: true, items: { select: { sku: true } } },
    });
    const registeredCosts = await prisma.productCost.findMany({
      where: { userId: liderId }, select: { sku: true }, distinct: ["sku"],
    });
    const registeredSkuSet = new Set(registeredCosts.map((c) => c.sku));
    missingCostTotal = allOrders.filter((o) =>
      o.items.some((i) => !i.sku || !registeredSkuSet.has(i.sku))
    ).length;
  }

  return res.json({
    orders: ordersWithProfit,
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum),
    missingCostTotal,
  });
});

// ─── GET /profit/orders ───────────────────────────────────────────────────────
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
// GET /orders/by-shipment/:shipmentId — busca pedido pelo ID do envio
router.get("/by-shipment/:shipmentId", requireAuth, async (req, res) => {
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
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

  return res.json({
    order: {
      ...order,
      mlId:  order.mlId ?? order.externalOrderId,
      token: {
        apelido:    order.channelAccount?.apelido ?? order.channelAccount?.externalNickname ?? null,
        mlNickname: order.channelAccount?.externalNickname ?? null,
      },
      profit:      p ? Math.round(p.profit      * 100) / 100 : null,
      margin:      p ? p.margin                              : null,
      mlFee:       p ? Math.round(p.mlFee       * 100) / 100 : null,
      shippingCost: p ? Math.round(p.shippingCost * 100) / 100 : null,
      mlTax:       p ? Math.round(p.mlTax       * 100) / 100 : null,
      nfTax:       p ? Math.round(p.nfTax       * 100) / 100 : null,
      productCost: p ? Math.round(p.productCost * 100) / 100 : null,
      estorno:     p ? Math.round(p.estorno     * 100) / 100 : null,
      allCostsFound: p ? p.allCostsFound : true,
      missingSkus: order.items.filter((i) => !i.sku).map((i) => i.title),
    },
  });
});
export default router;