import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { filterMlAccounts, getLiderId } from "../lib/filterMlAccounts";

const router = Router();

router.get("/stats", requireAuth, async (req, res) => {
  const user = req.user;
  const { brand } = req.query as { brand?: string };
  const tokenIds = await filterMlAccounts(user);
  const liderId = await getLiderId(user);
  const canViewProfit = user.role === "admin" || user.subscription?.plan?.canViewProfit;

  const orders = await prisma.order.findMany({
    where: { tokenId: { in: tokenIds }, status: { not: "cancelled" } },
    include: { items: true, payments: true },
    orderBy: { dateCreated: "desc" },
  });

  // ── Custos e alíquota pré-carregados (evita N+1) ──────────────────────────
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
    for (const c of list) { if (c.validFrom <= date) result = c; else break; }
    return result;
  }

  const allTaxSettings = await prisma.taxSetting.findMany({
    where: { userId: liderId },
    orderBy: { validFrom: "asc" },
  });
  function findTaxRate(date: Date): number {
    let result = 0;
    for (const t of allTaxSettings) { if (t.validFrom <= date) result = t.rate; else break; }
    return result;
  }

  // ── Filtro por marca (se selecionado) ───────────────────────────────────────
  let filteredOrders = orders;
  if (brand) {
    const skusOfBrand = new Set(
      allCosts.filter((c) => c.marca === brand).map((c) => c.sku)
    );
    filteredOrders = orders
      .map((o) => ({
        ...o,
        items: o.items.filter((i) => i.sku && skusOfBrand.has(i.sku)),
      }))
      .filter((o) => o.items.length > 0);
  }

  // Lista de marcas disponíveis (para popular o dropdown do filtro)
  const availableBrands = Array.from(
    new Set(allCosts.filter((c) => c.marca).map((c) => c.marca as string))
  ).sort();

  function calcProfit(order: typeof orders[number]) {
    const grossRevenue = order.totalAmount;
    const mlFee = order.items.reduce((acc, i) => acc + (i.saleFee ?? 0) * i.quantity, 0);
    const shippingCost = order.shippingCost ?? 0;
    const mlTax = order.taxesAmount > 0 ? order.taxesAmount : 0;
    const estorno = order.payments
      .filter((p) => p.operationType !== "regular_payment")
      .reduce((acc, p) => acc + (p.totalPaidAmount ?? 0), 0);
    const taxRate = findTaxRate(order.dateCreated);
    const nfTax = grossRevenue * (taxRate / 100);

    let productCost = 0;
    for (const item of order.items) {
      if (!item.sku) continue;
      const cost = findCost(item.sku, order.dateCreated);
      if (!cost) continue;
      productCost += cost.cost * item.quantity;
    }

    const profit = grossRevenue - mlFee - shippingCost - nfTax - productCost - mlTax + estorno;
    const cmv = productCost;
    return { grossRevenue, cmv, mlFee, shippingCost, nfTax, profit };
  }

  // ── Totais gerais ──────────────────────────────────────────────────────────
  const totalRevenue = filteredOrders.reduce((a, o) => a + o.totalAmount, 0);
  const totalOrders = filteredOrders.length;
  const avgTicket = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  let totalCmv = 0;
  let totalProfit = 0;
  if (canViewProfit) {
    for (const o of filteredOrders) {
      const r = calcProfit(o);
      totalCmv += r.cmv;
      totalProfit += r.profit;
    }
  }
  const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  // ── Monthly data (gráfico, últimos 6 meses) ─────────────────────────────────
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const monthlyOrders = filteredOrders.filter((o) => o.dateCreated >= sixMonthsAgo);

  const monthlyMap: Record<string, { receita: number; lucro: number }> = {};
  for (const o of monthlyOrders) {
    const key = o.dateCreated.toISOString().slice(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { receita: 0, lucro: 0 };
    monthlyMap[key].receita += o.totalAmount;
    if (canViewProfit) monthlyMap[key].lucro += calcProfit(o).profit;
  }
  const monthlyData = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      mes: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(key + "-01")),
      receita: Math.round(v.receita * 100) / 100,
      lucro: canViewProfit ? Math.round(v.lucro * 100) / 100 : null,
    }));

  // ── Status breakdown ─────────────────────────────────────────────────────
  const statusBreakdown = await prisma.order.groupBy({
    by: ["status"],
    where: { tokenId: { in: tokenIds } },
    _count: { id: true },
  });

  // ── Recent orders ─────────────────────────────────────────────────────────
  const recentOrders = await Promise.all(
    filteredOrders.slice(0, 10).map(async (order) => {
      let profit = null, margin = null;
      if (canViewProfit) {
        const r = calcProfit(order);
        profit = Math.round(r.profit * 100) / 100;
        margin = order.totalAmount > 0 ? Math.round((r.profit / order.totalAmount) * 1000) / 10 : 0;
      }
      return { ...order, profit, margin };
    })
  );

  // ── Venda por Canal (preparado para multi-marketplace; hoje só ML) ─────────
  const vendaPorCanal = [
    {
      canal: "Mercado Livre",
      qtd: totalOrders,
      faturado: Math.round(totalRevenue * 100) / 100,
      faturadoPct: 100,
      cmv: canViewProfit ? Math.round(totalCmv * 100) / 100 : null,
      cmvPct: canViewProfit && totalRevenue > 0 ? Math.round((totalCmv / totalRevenue) * 1000) / 10 : null,
      margem: canViewProfit ? Math.round(totalProfit * 100) / 100 : null,
      margemPct: canViewProfit ? Math.round(margin * 10) / 10 : null,
      comissao: null,
    },
  ];

  // ── Venda por Estado (UF) ───────────────────────────────────────────────────
  const stateMap: Record<string, { qtd: number; faturado: number; cmv: number; lucro: number }> = {};
  for (const o of filteredOrders) {
    const uf = (o as any).buyerState || "—";
    if (!stateMap[uf]) stateMap[uf] = { qtd: 0, faturado: 0, cmv: 0, lucro: 0 };
    stateMap[uf].qtd += 1;
    stateMap[uf].faturado += o.totalAmount;
    if (canViewProfit) {
      const r = calcProfit(o);
      stateMap[uf].cmv += r.cmv;
      stateMap[uf].lucro += r.profit;
    }
  }
  const vendaPorEstado = Object.entries(stateMap)
    .map(([uf, v]) => ({
      uf,
      qtd: v.qtd,
      faturado: Math.round(v.faturado * 100) / 100,
      faturadoPct: totalRevenue > 0 ? Math.round((v.faturado / totalRevenue) * 1000) / 10 : 0,
      cmv: canViewProfit ? Math.round(v.cmv * 100) / 100 : null,
      cmvPct: canViewProfit && v.faturado > 0 ? Math.round((v.cmv / v.faturado) * 1000) / 10 : null,
      margem: canViewProfit ? Math.round(v.lucro * 100) / 100 : null,
      margemPct: canViewProfit && v.faturado > 0 ? Math.round((v.lucro / v.faturado) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.faturado - a.faturado);

  // ── Venda por Produto ───────────────────────────────────────────────────────
  const productMap: Record<string, { sku: string; name: string; qtd: number; faturado: number; cmv: number; lucro: number }> = {};
  for (const o of filteredOrders) {
    const r = canViewProfit ? calcProfit(o) : null;
    const itemsRevenue = o.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0) || 1;

    for (const item of o.items) {
      const key = item.sku || item.title;
      if (!productMap[key]) productMap[key] = { sku: item.sku || "—", name: item.title, qtd: 0, faturado: 0, cmv: 0, lucro: 0 };
      productMap[key].qtd += item.quantity;
      const itemRevenue = item.unitPrice * item.quantity;
      productMap[key].faturado += itemRevenue;

      if (canViewProfit && r) {
        const proportion = itemRevenue / itemsRevenue;
        productMap[key].cmv += r.cmv * proportion;
        productMap[key].lucro += r.profit * proportion;
      }
    }
  }
  const vendaPorProduto = Object.values(productMap)
    .map((p) => ({
      sku: p.sku,
      name: p.name,
      qtd: p.qtd,
      faturado: Math.round(p.faturado * 100) / 100,
      faturadoPct: totalRevenue > 0 ? Math.round((p.faturado / totalRevenue) * 1000) / 10 : 0,
      cmv: canViewProfit ? Math.round(p.cmv * 100) / 100 : null,
      cmvPct: canViewProfit && p.faturado > 0 ? Math.round((p.cmv / p.faturado) * 1000) / 10 : null,
      margem: canViewProfit ? Math.round(p.lucro * 100) / 100 : null,
      margemPct: canViewProfit && p.faturado > 0 ? Math.round((p.lucro / p.faturado) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.faturado - a.faturado)
    .slice(0, 50);

  return res.json({
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalOrders,
    avgTicket: Math.round(avgTicket * 100) / 100,
    totalProfit: canViewProfit ? Math.round(totalProfit * 100) / 100 : null,
    totalCmv: canViewProfit ? Math.round(totalCmv * 100) / 100 : null,
    margin: canViewProfit ? Math.round(margin * 10) / 10 : null,
    monthlyData,
    recentOrders,
    statusBreakdown: statusBreakdown.map((s) => ({ status: s.status, count: s._count.id })),
    vendaPorCanal,
    vendaPorEstado,
    vendaPorProduto,
    availableBrands,
    selectedBrand: brand ?? null,
  });
});

export default router;