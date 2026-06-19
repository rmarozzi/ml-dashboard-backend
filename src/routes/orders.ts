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
      { items: { some: { title: { contains: search, mode: "insensitive" } } } },
    ];
  }

  const pageNum = parseInt(page);
  const limitNum = Math.min(parseInt(limit) || 50, 200); // cap máximo de 200
  const skip = (pageNum - 1) * limitNum;

  // Ordenação válida apenas para campos do banco (profit/margin calculados depois)
  const dbSortFields = ["mlId", "totalAmount", "dateCreated", "status"];
  const orderBy: any = dbSortFields.includes(sortField)
    ? { [sortField]: sortDir === "asc" ? "asc" : "desc" }
    : { dateCreated: "desc" };

  // Busca TODOS os ids que batem no filtro (sem include pesado) para contar total
  const allMatching = await prisma.order.findMany({
    where,
    select: { id: true },
  });
  const total = allMatching.length;

  // Busca a página atual com os relacionamentos completos
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
          missingSkus: order.items.filter(i => !i.sku).map(i => i.title),
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
        missingSkus: order.items.filter(i => !i.sku).map(i => i.title),
      };
    })
  );

  // Filtro "sem custo" aplicado após o cálculo (só nesta página)
  const finalOrders = onlyMissingCost === "true"
    ? ordersWithProfit.filter((o: any) => !o.allCostsFound)
    : ordersWithProfit;

  // Conta quantos pedidos no total (todas as páginas) estão sem custo
  // Isso é custoso, então fazemos uma query separada e mais leve
  let missingCostTotal = 0;
  if (canViewProfit) {
    const itemsNoSku = await prisma.item.findMany({
      where: { order: { tokenId: { in: tokenIds } }, sku: null },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    missingCostTotal = itemsNoSku.length;
  }

  return res.json({
    orders: finalOrders,
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