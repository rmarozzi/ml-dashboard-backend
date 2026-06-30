import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const user = await prisma.user.findUnique({ where: { id: liderId }, select: { settings: true } });
  const defaults = { autoSync: false, emailNotifications: true, syncAlerts: true };
  const settings = user?.settings ? { ...defaults, ...JSON.parse(user.settings) } : defaults;
  return res.json({ settings });
});

router.post("/", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);

  // Só o líder pode mudar o autoSync (requer plano Ouro+)
  if (req.body.autoSync !== undefined) {
    const lider = await prisma.user.findUnique({
      where: { id: liderId },
      include: { subscription: { include: { plan: true } } },
    });
    if (req.body.autoSync && !lider?.subscription?.plan?.autoSync) {
      return res.status(403).json({ message: "Sync automático disponível apenas no plano Ouro+" });
    }
  }

  const current = await prisma.user.findUnique({ where: { id: liderId }, select: { settings: true } });
  const currentSettings = current?.settings ? JSON.parse(current.settings) : {};
  const merged = { ...currentSettings, ...req.body };

  await prisma.user.update({
    where: { id: liderId },
    data: { settings: JSON.stringify(merged) },
  });
  return res.json({ ok: true, settings: merged });
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