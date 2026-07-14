import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";

const router = Router();

router.get("/stats", requireAuth, requireFuncionarioPermission("view_orders"), async (req, res) => {
  try {
    const liderId       = req.user.role === "funcionario" ? req.user.liderId : req.user.id;
    const canViewProfit = req.user.role === "admin" || req.user.subscription?.plan?.canViewProfit;

    const { dateFrom, dateTo, brand } = req.query as Record<string, string>;
    const brands = brand ? brand.split(",").map((b) => b.trim()).filter(Boolean) : [];

    // ── Filtro base ─────────────────────────────────────────────────────────
    const where: any = { userId: liderId, status: "paid" };
    if (dateFrom) where.dateCreated = { ...where.dateCreated, gte: new Date(dateFrom) };
    if (dateTo)   where.dateCreated = { ...where.dateCreated, lte: new Date(new Date(dateTo).setHours(23, 59, 59)) };

    if (brands.length > 0) {
      const skusWithBrand = await prisma.productCost.findMany({
        where: { userId: liderId, marca: { in: brands } },
        select: { sku: true },
        distinct: ["sku"],
      });
      where.items = { some: { sku: { in: skusWithBrand.map((c) => c.sku) } } };
    }

    // ── Busca pedidos com dados mínimos ──────────────────────────────────────
    const orders = await prisma.order.findMany({
      where,
      select: {
        id:          true,
        mlId:        true,
        externalOrderId: true,
        packId:      true,
        status:      true,
        totalAmount: true,
        taxesAmount: true,
        shippingCost: true,
        dateCreated: true,
        buyerState:  true,
        channelAccount: { select: { channelType: true } },
        items: {
          select: {
            id:       true,
            title:    true,
            quantity: true,
            unitPrice: true,
            sku:      true,
            saleFee:  true,
          },
        },
        payments: {
          select: {
            operationType:   true,
            totalPaidAmount: true,
          },
        },
      },
      orderBy: { dateCreated: "desc" },
    });

    // ── Pega taxa NF e custos de produto em batch ────────────────────────────
    // Em vez de calcular por pedido, usa uma única query para cada

    // Taxa NF efetiva (a mais recente)
    const taxSetting = await prisma.taxSetting.findFirst({
      where: { userId: liderId },
      orderBy: { validFrom: "desc" },
    });
    const taxRate = taxSetting?.rate ?? 0;

    // Custos de produto (todos de uma vez)
    const productCosts = await prisma.productCost.findMany({
      where: { userId: liderId },
      select: { sku: true, cost: true, validFrom: true },
      orderBy: { validFrom: "desc" },
    });

    // Mapa SKU → custo mais recente
    const costMap = new Map<string, number>();
    for (const pc of productCosts) {
      if (!costMap.has(pc.sku)) costMap.set(pc.sku, pc.cost);
    }

    // ── Calcula métricas por pedido (sem queries extras) ─────────────────────
    type OrderMetrics = {
      revenue:  number;
      mlFee:    number;
      shipping: number;
      nfTax:    number;
      cmv:      number;
      estorno:  number;
      profit:   number;
      hasCost:  boolean;
    };

    const metrics: OrderMetrics[] = orders.map((o) => {
      const revenue  = o.totalAmount;
      const mlFee    = o.items.reduce((acc, i) => acc + (i.saleFee ?? 0) * i.quantity, 0);
      const shipping = o.shippingCost ?? 0;
      const nfTax    = revenue * (taxRate / 100);
      const mlTax    = o.taxesAmount ?? 0;
      const estorno  = o.payments
        .filter((p) => p.operationType !== "regular_payment")
        .reduce((acc, p) => acc + (p.totalPaidAmount ?? 0), 0);

      let cmv = 0;
      let hasCost = true;
      for (const item of o.items) {
        if (!item.sku) { hasCost = false; continue; }
        const cost = costMap.get(item.sku);
        if (!cost) { hasCost = false; continue; }
        cmv += cost * item.quantity;
      }

      const profit = revenue - mlFee - shipping - nfTax - mlTax - cmv + estorno;

      return { revenue, mlFee, shipping, nfTax, cmv, estorno, profit, hasCost };
    });

    // ── KPIs ─────────────────────────────────────────────────────────────────
    const totalRevenue = metrics.reduce((acc, m) => acc + m.revenue, 0);
    const totalOrders  = orders.length;
    const avgTicket    = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const totalCmv     = canViewProfit ? metrics.reduce((acc, m) => acc + m.cmv, 0) : null;
    const totalProfit  = canViewProfit ? metrics.reduce((acc, m) => acc + m.profit, 0) : null;
    const margin       = canViewProfit && totalRevenue > 0
      ? (totalProfit! / totalRevenue) * 100 : null;

    // ── Receita mensal ────────────────────────────────────────────────────────
    const monthlyMap = new Map<string, { receita: number; lucro: number; qtd: number }>();
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      const m = metrics[i];
      const mes = o.dateCreated.toISOString().slice(0, 7);
      const cur = monthlyMap.get(mes) ?? { receita: 0, lucro: 0, qtd: 0 };
      cur.receita += o.totalAmount;
      cur.lucro   += m.profit;
      cur.qtd     += 1;
      monthlyMap.set(mes, cur);
    }
    const monthlyData = [...monthlyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([mes, v]) => ({
        mes:    new Date(mes + "-01").toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
        receita: Math.round(v.receita * 100) / 100,
        lucro:   canViewProfit ? Math.round(v.lucro * 100) / 100 : null,
        qtd:     v.qtd,
      }));

    // ── Status breakdown ──────────────────────────────────────────────────────
    const statusMap = new Map<string, number>();
    for (const o of orders) {
      statusMap.set(o.status, (statusMap.get(o.status) ?? 0) + 1);
    }
    const statusBreakdown = [...statusMap.entries()].map(([status, count]) => ({ status, count }));

    // ── Venda por canal ───────────────────────────────────────────────────────
    const canalMap = new Map<string, { qtde: number; faturado: number; margem: number; cmv: number }>();
    for (let i = 0; i < orders.length; i++) {
      const o     = orders[i];
      const m     = metrics[i];
      const canal = o.channelAccount?.channelType ?? "OUTRO";
      const cur   = canalMap.get(canal) ?? { qtde: 0, faturado: 0, margem: 0, cmv: 0 };
      cur.qtde     += 1;
      cur.faturado += o.totalAmount;
      cur.margem   += m.profit;
      cur.cmv      += m.cmv;
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
    for (let i = 0; i < orders.length; i++) {
      const o  = orders[i];
      const m  = metrics[i];
      const uf = o.buyerState ?? "Desconhecido";
      const cur = estadoMap.get(uf) ?? { qtd: 0, faturado: 0, margem: 0 };
      cur.qtd     += 1;
      cur.faturado += o.totalAmount;
      cur.margem  += m.profit;
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
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      const m = metrics[i];
      for (const item of o.items) {
        const key = item.sku ?? item.title;
        const cur = produtoMap.get(key) ?? { name: item.title, qtd: 0, faturado: 0, margem: 0 };
        cur.qtd     += item.quantity;
        cur.faturado += item.unitPrice * item.quantity;
        cur.margem  += m.profit / Math.max(o.items.length, 1);
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
    const recentOrders = orders.slice(0, 10).map((o, i) => ({
      id:          o.id,
      mlId:        o.mlId ?? o.externalOrderId,
      packId:      o.packId,
      status:      o.status,
      totalAmount: o.totalAmount,
      dateCreated: o.dateCreated,
      profit:      canViewProfit ? Math.round(metrics[i].profit * 100) / 100 : null,
      margin:      canViewProfit && o.totalAmount > 0
        ? Math.round((metrics[i].profit / o.totalAmount) * 10000) / 100
        : null,
      items: o.items.slice(0, 1),
    }));

    // ── Marcas disponíveis ────────────────────────────────────────────────────
    const availableBrands = await prisma.productCost.findMany({
      where:    { userId: liderId, marca: { not: null } },
      select:   { marca: true },
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
  } catch (err: any) {
    console.error("[Dashboard] Erro:", err?.message);
    return res.status(500).json({ message: err?.message });
  }
});

export default router;