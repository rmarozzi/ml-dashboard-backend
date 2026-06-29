import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requirePlan, requireFuncionarioPermission } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

// Data usada como "início dos tempos" — cadastro inicial de produto
// vale retroativamente para TODAS as vendas anteriores daquele SKU.
const EPOCH = new Date("2000-01-01T00:00:00.000Z");

router.get("/", requireAuth, requirePlan("prata"), async (req, res) => {
  const liderId = await getLiderId(req.user);

  const allCosts = await prisma.productCost.findMany({
    where: { userId: liderId },
    orderBy: [{ sku: "asc" }, { validFrom: "desc" }],
  });

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
  const { sku, name, cost } = req.body;
  if (!sku || !name || cost == null) {
    return res.status(400).json({ message: "Campos obrigatórios: sku, name, cost" });
  }
  const liderId = await getLiderId(req.user);

  const existing = await prisma.productCost.findFirst({
    where: { userId: liderId, sku: sku.trim() },
  });
  if (existing) {
    return res.status(409).json({ message: "Este SKU já está cadastrado. A edição será feita na tela de alteração (em breve)." });
  }

  const newCost = await prisma.productCost.create({
    data: {
      userId: liderId,
      sku: sku.trim(),
      name: name.trim(),
      cost: parseFloat(cost),
      taxRate: 0, // deprecado — alíquota agora é global, configurada no Perfil
      validFrom: EPOCH, // retroativo a todas as vendas anteriores
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