import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requirePlan, requireFuncionarioPermission } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

// Cadastro inicial de produto vale retroativamente para todas as vendas anteriores
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
  const { sku, name, cost, ean, ncm, cest, codFabricante, marca } = req.body;
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
      taxRate: 0,
      validFrom: EPOCH,
      ean: ean?.toString().trim() || null,
      ncm: ncm?.toString().trim() || null,
      cest: cest?.toString().trim() || null,
      codFabricante: codFabricante?.toString().trim() || null,
      marca: marca?.toString().trim() || null,
    },
  });
  return res.status(201).json({ cost: newCost });
});

// ─── Cadastro em massa via planilha ────────────────────────────────────────
router.post("/bulk", requireAuth, requirePlan("prata"), requireFuncionarioPermission("manage_costs"), async (req, res) => {
  const { products } = req.body as { products: any[] };
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: "Nenhum produto enviado" });
  }

  const liderId = await getLiderId(req.user);

  // Valida e normaliza cada linha
  const candidates: { row: number; sku: string; name: string; cost: number; ean: string | null; ncm: string | null; cest: string | null; codFabricante: string | null; marca: string | null }[] = [];
  const errors: { row: number; sku: string; message: string }[] = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const row = p._row ?? i + 2;
    const sku = (p.sku ?? "").toString().trim();
    const name = (p.name ?? "").toString().trim();
    const cost = parseFloat(String(p.cost).replace(",", "."));

    if (!sku || !name || isNaN(cost) || cost < 0) {
      errors.push({ row, sku: sku || "(vazio)", message: "Dados obrigatórios faltando ou inválidos (SKU, Descrição, Custo)" });
      continue;
    }

    candidates.push({
      row, sku, name, cost,
      ean: p.ean?.toString().trim() || null,
      ncm: p.ncm?.toString().trim() || null,
      cest: p.cest?.toString().trim() || null,
      codFabricante: p.codFabricante?.toString().trim() || null,
      marca: p.marca?.toString().trim() || null,
    });
  }

  // Checa SKUs já existentes no banco (uma única query)
  const candidateSkus = candidates.map((c) => c.sku);
  const existingRecords = candidateSkus.length > 0
    ? await prisma.productCost.findMany({
        where: { userId: liderId, sku: { in: candidateSkus } },
        select: { sku: true },
      })
    : [];
  const existingSkuSet = new Set(existingRecords.map((e) => e.sku));

  // Filtra duplicados (no banco e dentro da própria planilha)
  const seenSkus = new Set<string>();
  const toCreate: any[] = [];

  for (const c of candidates) {
    if (existingSkuSet.has(c.sku)) {
      errors.push({ row: c.row, sku: c.sku, message: "SKU já cadastrado no sistema — ignorado" });
      continue;
    }
    if (seenSkus.has(c.sku)) {
      errors.push({ row: c.row, sku: c.sku, message: "SKU duplicado na planilha — apenas o primeiro foi considerado" });
      continue;
    }
    seenSkus.add(c.sku);
    toCreate.push({
      userId: liderId,
      sku: c.sku,
      name: c.name,
      cost: c.cost,
      taxRate: 0,
      validFrom: EPOCH,
      ean: c.ean,
      ncm: c.ncm,
      cest: c.cest,
      codFabricante: c.codFabricante,
      marca: c.marca,
    });
  }

  if (toCreate.length > 0) {
    await prisma.productCost.createMany({ data: toCreate });
  }

  return res.json({
    total: products.length,
    created: toCreate.length,
    skipped: errors.length,
    errors,
  });
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