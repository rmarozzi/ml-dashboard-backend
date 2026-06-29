import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { settings: true } });
  const settings = user?.settings ? JSON.parse(user.settings) : {};
  return res.json({ settings });
});

router.post("/", requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { settings: JSON.stringify(req.body) },
  });
  return res.json({ ok: true });
});

// ─── Alíquota de Imposto NF (global, por cliente) ─────────────────────────────
router.get("/tax-rate", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const history = await prisma.taxSetting.findMany({
    where: { userId: liderId },
    orderBy: { validFrom: "desc" },
  });
  return res.json({ current: history[0] ?? null, history });
});

router.post("/tax-rate", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const { rate, validFrom } = req.body;
  if (rate == null || isNaN(Number(rate))) {
    return res.status(400).json({ message: "Alíquota inválida" });
  }

  // Primeira alíquota cadastrada vale retroativamente para todas as vendas
  const hasAny = await prisma.taxSetting.count({ where: { userId: liderId } });
  const effectiveDate = hasAny === 0
    ? new Date("2000-01-01T00:00:00.000Z")
    : (validFrom ? new Date(validFrom) : new Date());

  const setting = await prisma.taxSetting.create({
    data: { userId: liderId, rate: parseFloat(rate), validFrom: effectiveDate },
  });
  return res.status(201).json({ setting });
});

export default router;