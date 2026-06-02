import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { filterMlAccounts, getLiderId } from "../lib/filterMlAccounts";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

router.get("/stats", requireAuth, async (req, res) => {
  const user = req.user;
  const tokenIds = await filterMlAccounts(user);
  const liderId = await getLiderId(user);
  const canViewProfit = user.role === "admin" || user.subscription?.plan?.canViewProfit;

  const [orders, totalOrders] = await Promise.all([
    prisma.order.findMany({
      where: { tokenId: { in: tokenIds } },
      include: { items: true, payments: true },
      orderBy: { dateCreated: "desc" },
      take: 10,
    }),
    prisma.order.count({ where: { tokenId: { in: tokenIds } } }),
  ]);

  const totalRevenue = orders.reduce((a, o) => a + o.totalAmount, 0);
  const avgTicket = totalOrders > 0 ? totalRevenue / Math.min(totalOrders, orders.length) : 0;

  // Monthly data (last 6 months)
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const monthlyOrders = await prisma.order.findMany({
    where: { tokenId: { in: tokenIds }, dateCreated: { gte: sixMonthsAgo } },
    select: { totalAmount: true, netReceived: true, dateCreated: true },
  });

  const monthlyMap: Record<string, { receita: number; lucro: number }> = {};
  for (const o of monthlyOrders) {
    const key = o.dateCreated.toISOString().slice(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { receita: 0, lucro: 0 };
    monthlyMap[key].receita += o.totalAmount;
    if (canViewProfit && o.netReceived) monthlyMap[key].lucro += o.netReceived - o.totalAmount * 0.14;
  }

  const monthlyData = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      mes: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(key + "-01")),
      receita: Math.round(v.receita),
      lucro: canViewProfit ? Math.round(v.lucro) : null,
    }));

  // Status breakdown
  const statusBreakdown = await prisma.order.groupBy({
    by: ["status"],
    where: { tokenId: { in: tokenIds } },
    _count: { id: true },
  });

  // Add profit to recent orders
  const recentOrders = await Promise.all(
    orders.slice(0, 10).map(async (order) => {
      let profit = null, margin = null;
      if (canViewProfit) {
        const p = await calculateOrderProfit(order.id);
        profit = p ? Math.round(p.profit * 100) / 100 : null;
        margin = p ? p.margin : null;
      }
      return { ...order, profit, margin };
    })
  );

  return res.json({
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalOrders,
    avgTicket: Math.round(avgTicket * 100) / 100,
    totalProfit: canViewProfit ? recentOrders.reduce((a, o) => a + (o.profit ?? 0), 0) : null,
    monthlyData,
    recentOrders,
    statusBreakdown: statusBreakdown.map((s) => ({ status: s.status, count: s._count.id })),
  });
});

export default router;
