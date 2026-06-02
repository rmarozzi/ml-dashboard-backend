import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFeature, requireFuncionarioPermission } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";
import { calculateOrderProfit } from "../lib/profit";

const router = Router();

const toCsv = (rows: Record<string, any>[]) => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => JSON.stringify(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
};

router.get("/orders", requireAuth, requireFeature("canExport"), requireFuncionarioPermission("export_data"), async (req, res) => {
  const tokenIds = await filterMlAccounts(req.user);
  const orders = await prisma.order.findMany({
    where: { tokenId: { in: tokenIds } },
    include: { items: true, payments: true, token: { select: { apelido: true } } },
    orderBy: { dateCreated: "desc" },
    take: 5000,
  });

  const rows = orders.map((o) => ({
    id: o.mlId,
    status: o.status,
    data: o.dateCreated.toISOString(),
    total: o.totalAmount,
    conta: o.token?.apelido ?? "",
    produto: o.items[0]?.title ?? "",
  }));

  const csv = toCsv(rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=pedidos.csv");
  return res.send(csv);
});

router.get("/profit", requireAuth, requireFeature("canExport"), requireFuncionarioPermission("export_data"), async (req, res) => {
  const tokenIds = await filterMlAccounts(req.user);
  const orders = await prisma.order.findMany({
    where: { tokenId: { in: tokenIds } },
    include: { items: true, payments: true },
    orderBy: { dateCreated: "desc" },
    take: 2000,
  });

  const rows = await Promise.all(orders.map(async (o) => {
    const p = await calculateOrderProfit(o.id);
    return {
      id: o.mlId,
      data: o.dateCreated.toISOString(),
      total: o.totalAmount,
      lucro: p?.profit?.toFixed(2) ?? "",
      margem: p?.margin?.toFixed(2) ?? "",
    };
  }));

  const csv = toCsv(rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=lucro.csv");
  return res.send(csv);
});

router.get("/costs", requireAuth, requireFeature("canExport"), requireFuncionarioPermission("export_data"), async (req, res) => {
  const costs = await prisma.productCost.findMany({
    where: { userId: req.user.id },
    orderBy: [{ sku: "asc" }, { validFrom: "desc" }],
  });

  const csv = toCsv(costs.map((c) => ({
    sku: c.sku, nome: c.name, custo: c.cost, aliquota: c.taxRate, vigencia: c.validFrom.toISOString(),
  })));

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=custos.csv");
  return res.send(csv);
});

export default router;
