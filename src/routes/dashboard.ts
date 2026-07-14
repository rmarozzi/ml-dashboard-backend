import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

router.get("/stats", requireAuth, requireFuncionarioPermission("view_orders"), async (req, res) => {
  const liderId       = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
  const canViewProfit = req.user.role === "admin" || req.user.subscription?.plan?.canViewProfit;

  const { dateFrom, dateTo, brand } = req.query as Record<string, string>;
  const brands = brand ? brand.split(",").map((b) => b.trim()).filter(Boolean) : [];

  // ── Filtro base ───────────────────────────────────────────────────────────
  const where: any = { userId: liderId, status: "paid" };
  if (dateFrom) where.dateCreated = { ...where.dateCreated, gte: new Date(dateFrom) };
  if (dateTo)   where.dateCreated = { ...where.dateCreated, lte: new Date(new Date(dateTo).setHours(23, 59, 59)) };

  // Filtro por marca — via SKU dos itens
  if (brands.length > 0) {
    const skusWithBrand = await prisma.productCost.findMany({
      where: { userId: liderId, marca: { in: brands } },
      select: { sku: true },
      distinct: ["sku"],
    });
    const skus = skusWithBrand.map((c) => c.sku);
    where.items = { some: { sku: { in: skus } } };
  }

  // ── Busca pedidos ─────────────────────────────────────────────────────────
  const orders = await prisma.order.findMany({
    where,
    include: {
      items:          true,
      payments:       true,
      channelAccount: { select: { channelType: true, apelido: true, externalNickname: true } },
    },
    orderBy: { dateCreated: "desc" },
  });

  // ── Calcula lucro por pedido ───────────────────────────────────────────────
  const ordersWithProfit = await Promise.all(
    orders.map(async (o) => {
      if (!canViewProfit) return { ...o, profit: null, margin: null, cmv: null };
      const p = await calculateOrderProfit(o.id);
      return {
        ...o,
        profit: p?.profit ?? null,
        margin: p?.margin ?? null,
        cmv:    p?.productCost ?? null,
      };
    })
  );

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalRevenue = ordersWithProfit.reduce((acc, o) => acc + o.totalAmount, 0);
  const totalOrders  = ordersWithProfit.length;
  const avgTicket    = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const totalProfit  = canViewProfit
    ? ordersWithProfit.reduce((acc, o) => acc + (o.profit ?? 0), 0)
    : null;
  const totalCmv = canViewProfit
    ? ordersWithProfit.reduce((acc, o) => acc + (o.cmv ?? 0), 0)
    : null;
  const margin = canViewProfit && totalRevenue > 0
    ? (totalProfit! / totalRevenue) * 100
    : null;

  // ── Receita mensal (últimos 6 meses) ──────────────────────────────────────
  const monthlyMap = new Map<string, { receita: number; lucro: number; qtd: number }>();
  for (const o of ordersWithProfit) {
    const mes = o.dateCreated.toISOString().slice(0, 7); // "2026-07"
    const cur = monthlyMap.get(mes) ?? { receita: 0, lucro: 0, qtd: 0 };
    cur.receita += o.totalAmount;
    cur.lucro   += o.profit ?? 0;
    cur.qtd     += 1;
    monthlyMap.set(mes, cur);
  }
  const monthlyData = [...monthlyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([mes, v]) => ({
      mes: new Date(mes + "-01").toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
      receita: Math.round(v.receita * 100) / 100,
      lucro:   canViewProfit ? Math.round(v.lucro * 100) / 100 : null,
      qtd:     v.qtd,
    }));

  // ── Status breakdown ──────────────────────────────────────────────────────
  const statusMap = new Map<string, number>();
  for (const o of ordersWithProfit) {
    statusMap.set(o.status, (statusMap.get(o.status) ?? 0) + 1);
  }
  const statusBreakdown = [...statusMap.entries()].map(([status, count]) => ({ status, count }));

  // ── Venda por canal ───────────────────────────────────────────────────────
  const canalMap = new Map<string, { qtde: number; faturado: number; margem: number; cmv: number }>();
  for (const o of ordersWithProfit) {
    const canal = o.channelAccount?.channelType ?? "OUTRO";
    const cur   = canalMap.get(canal) ?? { qtde: 0, faturado: 0, margem: 0, cmv: 0 };
    cur.qtde     += 1;
    cur.faturado += o.totalAmount;
    cur.margem   += o.profit ?? 0;
    cur.cmv      += o.cmv ?? 0;
    canalMap.set(canal, cur);
  }
  const vendaPorCanal = [...canalMap.entries()].map(([canal, v]) => ({
    canal,
    qtde:        v.qtde,
    faturado:    Math.round(v.faturado * 100) / 100,
    faturadoPct: totalRevenue > 0 ? Math.round((v.faturado / totalRevenue) * 1000) / 10 : 0,
    cmv:         canViewProfit ? Math.round(v.cmv * 100) / 100 : null,
    cmvPct:      canViewProfit && v.faturado > 0 ? Math.round((v.cmv / v.faturado) * 1000) / 10 : null,
    margem:      canViewProfit ? Math.round(v.margem * 100) / 100 : null,
    margemPct:   canViewProfit && v.faturado > 0 ? Math.round((v.margem / v.faturado) * 1000) / 10 : null,
  })).sort((a, b) => b.faturado - a.faturado);

  // ── Venda por estado ──────────────────────────────────────────────────────
  const estadoMap = new Map<string, { qtd: number; faturado: number; margem: number }>();
  for (const o of ordersWithProfit) {
    const uf = o.buyerState ?? "Desconhecido";
    const cur = estadoMap.get(uf) ?? { qtd: 0, faturado: 0, margem: 0 };
    cur.qtd     += 1;
    cur.faturado += o.totalAmount;
    cur.margem  += o.profit ?? 0;
    estadoMap.set(uf, cur);
  }
  const vendaPorEstado = [...estadoMap.entries()]
    .map(([uf, v]) => ({
      uf,
      qtd:         v.qtd,
      faturado:    Math.round(v.faturado * 100) / 100,
      faturadoPct: totalRevenue > 0 ? Math.round((v.faturado / totalRevenue) * 1000) / 10 : 0,
      margemPct:   canViewProfit && v.faturado > 0 ? Math.round((v.margem / v.faturado) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.faturado - a.faturado)
    .slice(0, 20);

  // ── Venda por produto ─────────────────────────────────────────────────────
  const produtoMap = new Map<string, { name: string; qtd: number; faturado: number; margem: number }>();
  for (const o of ordersWithProfit) {
    for (const item of o.items) {
      const key = item.sku ?? item.title;
      const cur = produtoMap.get(key) ?? { name: item.title, qtd: 0, faturado: 0, margem: 0 };
      cur.qtd     += item.quantity;
      cur.faturado += item.unitPrice * item.quantity;
      cur.margem  += o.profit != null ? (o.profit / (o.items.length || 1)) : 0;
      produtoMap.set(key, cur);
    }
  }
  const vendaPorProduto = [...produtoMap.entries()]
    .map(([_, v]) => ({
      name:      v.name,
      qtd:       v.qtd,
      faturado:  Math.round(v.faturado * 100) / 100,
      margemPct: canViewProfit && v.faturado > 0 ? Math.round((v.margem / v.faturado) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.faturado - a.faturado)
    .slice(0, 20);

  // ── Pedidos recentes ──────────────────────────────────────────────────────
  const recentOrders = ordersWithProfit.slice(0, 10).map((o) => ({
    id:          o.id,
    mlId:        o.mlId ?? o.externalOrderId,
    packId:      o.packId,
    status:      o.status,
    totalAmount: o.totalAmount,
    dateCreated: o.dateCreated,
    profit:      o.profit != null ? Math.round(o.profit * 100) / 100 : null,
    margin:      o.margin,
    items:       o.items.slice(0, 1),
  }));

  // ── Marcas disponíveis ────────────────────────────────────────────────────
  const availableBrands = await prisma.productCost.findMany({
    where:  { userId: liderId, marca: { not: null } },
    select: { marca: true },
    distinct: ["marca"],
  });

  return res.json({
    totalRevenue:    Math.round(totalRevenue * 100) / 100,
    totalCmv:        totalCmv != null ? Math.round(totalCmv * 100) / 100 : null,
    totalProfit:     totalProfit != null ? Math.round(totalProfit * 100) / 100 : null,
    margin:          margin != null ? Math.round(margin * 100) / 100 : null,
    totalOrders,
    avgTicket:       Math.round(avgTicket * 100) / 100,
    monthlyData,
    statusBreakdown,
    vendaPorCanal,
    vendaPorEstado,
    vendaPorProduto,
    recentOrders,
    availableBrands: availableBrands.map((b) => b.marca).filter(Boolean),
  });
});

export default router;