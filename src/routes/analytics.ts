import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requirePlan, requireFuncionarioPermission } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";

const router = Router();

router.get("/", requireAuth, requirePlan("ouro"), requireFuncionarioPermission("view_analytics"), async (req, res) => {
  const { range = "30d" } = req.query as { range: string };
  const tokenIds = await filterMlAccounts(req.user);

  const days = range === "7d" ? 7 : range === "90d" ? 90 : range === "12m" ? 365 : 30;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const orders = await prisma.order.findMany({
    where: { tokenId: { in: tokenIds }, dateCreated: { gte: from } },
    include: { payments: true },
    orderBy: { dateCreated: "asc" },
  });

  const revenue = orders.reduce((a, o) => a + o.totalAmount, 0);
  const totalFees = orders.reduce((a, o) => a + o.payments.reduce((b, p) => b + p.taxesAmount, 0), 0);
  const cost = totalFees + revenue * 0.50; // simplified: fees + ~50% product cost
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const avgTicket = orders.length > 0 ? revenue / orders.length : 0;

  // Group by period
  const groupMap: Record<string, { receita: number; custo: number; lucro: number }> = {};
  for (const o of orders) {
    const key = range === "12m"
      ? o.dateCreated.toISOString().slice(0, 7)
      : o.dateCreated.toISOString().slice(0, 10);
    if (!groupMap[key]) groupMap[key] = { receita: 0, custo: 0, lucro: 0 };
    const fees = o.payments.reduce((b, p) => b + p.taxesAmount, 0);
    const itemCost = o.totalAmount * 0.5;
    groupMap[key].receita += o.totalAmount;
    groupMap[key].custo += fees + itemCost;
    groupMap[key].lucro += o.totalAmount - fees - itemCost;
  }

  const byPeriod = Object.entries(groupMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, v]) => ({
      label: range === "12m"
        ? new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(new Date(label + "-01"))
        : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(label)),
      receita: Math.round(v.receita),
      custo: Math.round(v.custo),
      lucro: Math.round(v.lucro),
    }));

  // Payment methods from payments table
  const paymentGroups = await prisma.payment.groupBy({
    by: ["operationType"],
    where: { order: { tokenId: { in: tokenIds }, dateCreated: { gte: from } } },
    _count: { id: true },
  });
  const totalPayments = paymentGroups.reduce((a, p) => a + p._count.id, 0);
  const methodLabels: Record<string, string> = {
    regular_payment: "Crédito", account_money: "Conta ML",
    debit_card: "Débito", ticket: "Boleto", pix: "Pix",
  };
  const paymentMethods = paymentGroups.map((p) => ({
    name: methodLabels[p.operationType] ?? p.operationType,
    value: totalPayments > 0 ? Math.round((p._count.id / totalPayments) * 100) : 0,
  }));

  return res.json({
    revenue: Math.round(revenue * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    margin: Math.round(margin * 10) / 10,
    orders: orders.length,
    avgTicket: Math.round(avgTicket * 100) / 100,
    byPeriod,
    paymentMethods,
  });
});

export default router;
