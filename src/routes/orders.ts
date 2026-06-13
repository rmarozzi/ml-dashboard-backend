import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission, requirePlan } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

// GET /orders
router.get("/", requireAuth, requireFuncionarioPermission("view_orders"), async (req, res) => {
  const { search, status, page = "1", limit = "50" } = req.query as Record<string, string>;
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

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true, payments: true, token: { select: { apelido: true, mlNickname: true } } },
      orderBy: { dateCreated: "desc" },
      skip,
      take: parseInt(limit),
    }),
    prisma.order.count({ where }),
  ]);

const ordersWithProfit = await Promise.all(
    orders.map(async (order) => {
      if (!canViewProfit) return { ...order, profit: null, margin: null };
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
      };
    })
  );

  return res.json({ orders: ordersWithProfit, total, page: parseInt(page), limit: parseInt(limit) });
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
