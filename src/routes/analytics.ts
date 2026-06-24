import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requirePlan, requireFuncionarioPermission } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";

const router = Router();

// Labels amigáveis para os métodos de pagamento reais do Mercado Pago
const PAYMENT_LABELS: Record<string, string> = {
  pix: "Pix",
  account_money: "Saldo Mercado Pago",
  master: "Mastercard",
  visa: "Visa",
  elo: "Elo",
  amex: "American Express",
  hipercard: "Hipercard",
  bolbradesco: "Boleto",
  debvisa: "Débito Visa",
  debmaster: "Débito Mastercard",
  debelo: "Débito Elo",
};

function paymentLabel(id: string | null): string {
  if (!id) return "Outro";
  return PAYMENT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function getDateRange(range: string): { from: Date; to: Date } {
  const now = new Date();
  const to = now;

  if (range === "today") {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }

  const days = range === "7d" ? 7 : range === "90d" ? 90 : range === "12m" ? 365 : 30;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

router.get("/", requireAuth, requirePlan("ouro"), requireFuncionarioPermission("view_analytics"), async (req, res) => {
  const { range = "30d" } = req.query as { range: string };
  const tokenIds = await filterMlAccounts(req.user);
  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const { from, to } = getDateRange(range);

  const orders = await prisma.order.findMany({
    where: {
      tokenId: { in: tokenIds },
      dateCreated: { gte: from, lte: to },
      status: { not: "cancelled" },
    },
    include: { items: true, payments: true },
    orderBy: { dateCreated: "asc" },
  });

  // Pré-carrega todos os custos cadastrados do usuário (evita N+1 queries)
  const allCosts = await prisma.productCost.findMany({
    where: { userId: liderId },
    orderBy: { validFrom: "asc" },
  });
  const costsBySku: Record<string, typeof allCosts> = {};
  for (const c of allCosts) {
    if (!costsBySku[c.sku]) costsBySku[c.sku] = [];
    costsBySku[c.sku].push(c);
  }

  function findCost(sku: string, date: Date) {
    const list = costsBySku[sku];
    if (!list) return null;
    let result = null;
    for (const c of list) {
      if (c.validFrom <= date) result = c;
      else break;
    }
    return result;
  }

  function calcOrderProfit(order: typeof orders[number]) {
    const grossRevenue = order.totalAmount;
    const mlFee = order.items.reduce(
      (acc, item) => acc + (item.saleFee ?? 0) * item.quantity, 0
    );
    const shippingCost = order.shippingCost ?? 0;
    const mlTax = order.taxesAmount > 0 ? order.taxesAmount : 0;
    const paymentEstorno = order.payments
      .filter((p) => p.operationType !== "regular_payment")
      .reduce((acc, p) => acc + (p.totalPaidAmount ?? 0), 0);
    const estorno = paymentEstorno + (order.shippingDiscount ?? 0);

    let productCostTotal = 0;
    let nfTaxTotal = 0;
    for (const item of order.items) {
      if (!item.sku) continue;
      const cost = findCost(item.sku, order.dateCreated);
      if (!cost) continue;
      productCostTotal += cost.cost * item.quantity;
      nfTaxTotal += (item.unitPrice * item.quantity) * (cost.taxRate / 100);
    }

    const profit = grossRevenue - mlFee - shippingCost - nfTaxTotal - productCostTotal - mlTax + estorno;
    const cost = mlFee + shippingCost + nfTaxTotal + productCostTotal + mlTax;
    return { grossRevenue, cost, profit };
  }

  let revenue = 0, cost = 0, profit = 0;
  const groupMap: Record<string, { receita: number; custo: number; lucro: number }> = {};
  const useMonthGrouping = range === "12m";

  for (const order of orders) {
    const r = calcOrderProfit(order);
    revenue += r.grossRevenue;
    cost += r.cost;
    profit += r.profit;

    const key = useMonthGrouping
      ? order.dateCreated.toISOString().slice(0, 7)
      : order.dateCreated.toISOString().slice(0, 10);

    if (!groupMap[key]) groupMap[key] = { receita: 0, custo: 0, lucro: 0 };
    groupMap[key].receita += r.grossRevenue;
    groupMap[key].custo += r.cost;
    groupMap[key].lucro += r.profit;
  }

  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const avgTicket = orders.length > 0 ? revenue / orders.length : 0;

  const byPeriod = Object.entries(groupMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, v]) => ({
      label: useMonthGrouping
        ? new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(new Date(label + "-01"))
        : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(label)),
      receita: Math.round(v.receita * 100) / 100,
      custo: Math.round(v.custo * 100) / 100,
      lucro: Math.round(v.lucro * 100) / 100,
    }));

  // Formas de pagamento reais (payment_method_id)
  const paymentGroups = await prisma.payment.groupBy({
    by: ["paymentMethodId"],
    where: { order: { tokenId: { in: tokenIds }, dateCreated: { gte: from, lte: to }, status: { not: "cancelled" } } },
    _count: { id: true },
  });
  const totalPayments = paymentGroups.reduce((a, p) => a + p._count.id, 0);
  const paymentMethods = paymentGroups
    .map((p) => ({
      name: paymentLabel(p.paymentMethodId),
      value: totalPayments > 0 ? Math.round((p._count.id / totalPayments) * 100) : 0,
    }))
    .sort((a, b) => b.value - a.value);

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