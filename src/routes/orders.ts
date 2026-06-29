import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission, requirePlan } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

// GET /orders
router.get("/", requireAuth, requireFuncionarioPermission("view_orders"), async (req, res) => {
  const {
    search, status, page = "1", limit = "50",
    sortField = "dateCreated", sortDir = "desc",
    onlyMissingCost,
  } = req.query as Record<string, string>;

  const tokenIds = await filterMlAccounts(req.user);
  const canViewProfit = req.user.role === "admin" || req.user.subscription?.plan?.canViewProfit;

  const where: any = { tokenId: { in: tokenIds } };
  if (status) where.status = status;
if (search) {
  where.OR = [
    { mlId: { contains: search, mode: "insensitive" } },
    { packId: { contains: search, mode: "insensitive" } },
    { items: { some: { title: { contains: search, mode: "insensitive" } } } },
  ];
}

  const pageNum = parseInt(page);
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const skip = (pageNum - 1) * limitNum;

  const dbSortFields = ["mlId", "totalAmount", "dateCreated", "status"];
  const orderBy: any = dbSortFields.includes(sortField)
    ? { [sortField]: sortDir === "asc" ? "asc" : "desc" }
    : { dateCreated: "desc" };

  // ── Filtro "sem custo cadastrado" aplicado ANTES da paginação ──────────────
  if (onlyMissingCost === "true" && canViewProfit) {
    // Busca todos os IDs de pedidos que batem no filtro base (status/search/tokenIds)
    const candidateOrders = await prisma.order.findMany({
      where,
      select: { id: true, dateCreated: true, items: { select: { sku: true } } },
    });

    // Pega todos os SKUs únicos do usuário que JÁ têm custo cadastrado
    const liderIdForCosts = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
    const registeredCosts = await prisma.productCost.findMany({
      where: { userId: liderIdForCosts },
      select: { sku: true },
      distinct: ["sku"],
    });
    const registeredSkuSet = new Set(registeredCosts.map((c) => c.sku));

    // Um pedido está "sem custo" se algum item não tem SKU OU o SKU não está cadastrado
    const missingCostOrderIds = candidateOrders
      .filter((o) =>
        o.items.some((i) => !i.sku || !registeredSkuSet.has(i.sku))
      )
      .map((o) => o.id);

    const missingCostTotal = missingCostOrderIds.length;

    // Pagina apenas dentro do conjunto de pedidos sem custo
    where.id = { in: missingCostOrderIds };

    const total = missingCostTotal;
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: true,
        payments: true,
        token: { select: { apelido: true, mlNickname: true } },
      },
      orderBy,
      skip,
      take: limitNum,
    });

    const ordersWithProfit = await Promise.all(
      orders.map(async (order) => {
        const p = await calculateOrderProfit(order.id);
        return {
          ...order,
          profit: p ? Math.round(p.profit * 100) / 100 : null,
          margin: p ? p.margin : null,
          mlFee: p ? Math.round(p.mlFee * 100) / 100 : null,
          shippingCost: p ? Math.round(p.shippingCost * 100) / 100 : null,
          mlTax: p ? Math.round(p.mlTax * 100) / 100 : null,
          nfTax: p ? Math.round(p.nfTax * 100) / 100 : null,
          productCost: p ? Math.round(p.productCost * 100) / 100 : null,
          estorno: p ? Math.round(p.estorno * 100) / 100 : null,
          allCostsFound: p ? p.allCostsFound : false,
          missingSkus: order.items.filter((i) => !i.sku).map((i) => i.title),
        };
      })
    );

    return res.json({
      orders: ordersWithProfit,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
      missingCostTotal,
    });
  }

  // ── Fluxo normal (sem filtro de custo) ──────────────────────────────────────
  const total = await prisma.order.count({ where });

  const orders = await prisma.order.findMany({
    where,
    include: {
      items: true,
      payments: true,
      token: { select: { apelido: true, mlNickname: true } },
    },
    orderBy,
    skip,
    take: limitNum,
  });

  const ordersWithProfit = await Promise.all(
    orders.map(async (order) => {
      if (!canViewProfit) {
        return {
          ...order,
          profit: null, margin: null,
          missingSkus: order.items.filter((i) => !i.sku).map((i) => i.title),
        };
      }
      const p = await calculateOrderProfit(order.id);
      return {
        ...order,
        profit: p ? Math.round(p.profit * 100) / 100 : null,
        margin: p ? p.margin : null,
        mlFee: p ? Math.round(p.mlFee * 100) / 100 : null,
        shippingCost: p ? Math.round(p.shippingCost * 100) / 100 : null,
        mlTax: p ? Math.round(p.mlTax * 100) / 100 : null,
        nfTax: p ? Math.round(p.nfTax * 100) / 100 : null,
        productCost: p ? Math.round(p.productCost * 100) / 100 : null,
        estorno: p ? Math.round(p.estorno * 100) / 100 : null,
        allCostsFound: p ? p.allCostsFound : false,
        missingSkus: order.items.filter((i) => !i.sku).map((i) => i.title),
      };
    })
  );

  // Calcula o total geral de pedidos sem custo (para o badge do botão, sem filtro ativo)
  let missingCostTotal = 0;
  if (canViewProfit) {
    const liderIdForCosts = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
    const allOrdersBase = await prisma.order.findMany({
      where: { tokenId: { in: tokenIds } },
      select: { id: true, items: { select: { sku: true } } },
    });
    const registeredCosts = await prisma.productCost.findMany({
      where: { userId: liderIdForCosts },
      select: { sku: true },
      distinct: ["sku"],
    });
    const registeredSkuSet = new Set(registeredCosts.map((c) => c.sku));
    missingCostTotal = allOrdersBase.filter((o) =>
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

// GET /profit/orders
router.get("/profit", requireAuth, requirePlan("prata"), requireFuncionarioPermission("view_profit"), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const tokenIds = await filterMlAccounts(req.user);

  const where: any = { tokenId: { in: tokenIds } };
  if (from) where.dateCreated = { ...where.dateCreated, gte: new Date(from) };
  if (to) where.dateCreated = { ...where.dateCreated, lte: new Date(to) };

  const orders = await prisma.order.findMany({
    where,
    include: { items: true, payments: true, token: { select: { apelido: true } } },
    orderBy: { dateCreated: "desc" },
    take: 500,
  });

  const result = await Promise.all(
    orders.map(async (o) => {
      const profit = await calculateOrderProfit(o.id);
      return { ...o, ...profit };
    })
  );

  return res.json({ orders: result });
});

export default router;