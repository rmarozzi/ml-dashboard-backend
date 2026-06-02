import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requirePlan, requireFuncionarioPermission } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

router.get("/", requireAuth, requirePlan("prata"), async (req, res) => {
  const liderId = await getLiderId(req.user);

  // Get latest cost per SKU + history
  const allCosts = await prisma.productCost.findMany({
    where: { userId: liderId },
    orderBy: [{ sku: "asc" }, { validFrom: "desc" }],
  });

  // Group by SKU: first is current, rest is history
  const grouped: Record<string, any> = {};
  for (const cost of allCosts) {
    if (!grouped[cost.sku]) {
      grouped[cost.sku] = { ...cost, history: [] };
    } else {
      grouped[cost.sku].history.push(cost);
    }
  }

  return res.json({ costs: Object.values(grouped) });
});

router.post("/", requireAuth, requirePlan("prata"), requireFuncionarioPermission("manage_costs"), async (req, res) => {
  const { sku, name, cost, taxRate, validFrom } = req.body;
  if (!sku || !name || cost == null || taxRate == null) {
    return res.status(400).json({ message: "Campos obrigatórios: sku, name, cost, taxRate" });
  }
  const liderId = await getLiderId(req.user);
  const newCost = await prisma.productCost.create({
    data: {
      userId: liderId,
      sku: sku.trim(),
      name: name.trim(),
      cost: parseFloat(cost),
      taxRate: parseFloat(taxRate),
      validFrom: validFrom ? new Date(validFrom) : new Date(),
    },
  });
  return res.status(201).json({ cost: newCost });
});

router.delete("/:id", requireAuth, requirePlan("prata"), requireFuncionarioPermission("manage_costs"), async (req, res) => {
  const liderId = await getLiderId(req.user);
  const cost = await prisma.productCost.findFirst({
    where: { id: parseInt(String(req.params.id)), userId: liderId },
  });
  if (!cost) return res.status(404).json({ message: "Custo não encontrado" });

  await prisma.productCost.delete({ where: { id: cost.id } });
  return res.json({ ok: true });
});

export default router;
