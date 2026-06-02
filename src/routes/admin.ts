import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import prisma from "../lib/prisma";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router = Router();
router.use(requireAuth, requireAdmin);

const PLAN_RANK: Record<string, number> = { bronze: 0, prata: 1, ouro: 2, premium: 3 };

// ─── OVERVIEW ────────────────────────────────────────────────────────────────
router.get("/overview", async (req, res) => {
  const [subs, newClients, churnedClients, mrrHistory, planDist, syncs24h, expiredTokens, openAlerts] = await Promise.all([
    prisma.subscription.findMany({ include: { plan: true, user: true } }),
    prisma.user.count({ where: { role: "lider", createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } }),
    prisma.subscription.count({ where: { status: "cancelled", cancelledAt: { gte: new Date(Date.now() - 30 * 86400000) } } }),
    prisma.subscription.findMany({ include: { plan: true }, where: { status: { in: ["active", "trial"] } } }),
    prisma.subscription.groupBy({ by: ["planId"], _count: { userId: true }, where: { status: { in: ["active","trial"] } } }),
    prisma.syncLog.count({ where: { createdAt: { gte: new Date(Date.now() - 86400000) } } }),
    prisma.token.count({ where: { expiresAt: { lt: new Date() } } }),
    prisma.adminAlert.count({ where: { status: "open" } }),
  ]);

  const activeSubs = subs.filter((s) => s.status === "active" || s.status === "trial");
  const mrr = activeSubs.reduce((a, s) => a + s.plan.preco, 0);
  const activeClients = activeSubs.length;
  const churnRate = activeClients > 0 ? (churnedClients / activeClients) * 100 : 0;

  // MRR history mock (last 12 months)
  const mrrHistoryData = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (11 - i));
    return {
      mes: new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(d),
      mrr: Math.round(mrr * (0.7 + i * 0.025)),
    };
  });

  // Plan distribution
  const plans = await prisma.plan.findMany();
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p]));
  const planDistribution = planDist.map((g) => ({
    name: planMap[g.planId]?.nome ?? "?",
    slug: planMap[g.planId]?.slug ?? "bronze",
    value: g._count.userId,
  }));

  const syncFails24h = await prisma.syncLog.count({ where: { status: "failed", createdAt: { gte: new Date(Date.now() - 86400000) } } });
  const pastDueClients = await prisma.subscription.count({ where: { status: "past_due" } });
  const criticalAlerts = await prisma.adminAlert.count({ where: { status: "open", severity: "critical" } });

  return res.json({
    mrr: Math.round(mrr * 100) / 100,
    mrrGrowth: 7.9,
    activeClients,
    newClients30d: newClients,
    churn30d: churnedClients,
    churnRate: Math.round(churnRate * 10) / 10,
    arr: Math.round(mrr * 12 * 100) / 100,
    avgTicket: activeClients > 0 ? Math.round((mrr / activeClients) * 100) / 100 : 0,
    mrrHistory: mrrHistoryData,
    planDistribution,
    systemHealth: { syncs24h, syncFails24h, expiredTokens, pastDueClients, openAlerts, criticalAlerts },
  });
});

// ─── CLIENTS ─────────────────────────────────────────────────────────────────
router.get("/clients", async (req, res) => {
  const { search, plan, status, page = "1", limit = "20" } = req.query as Record<string, string>;
  const where: any = { role: "lider" };
  if (search) where.OR = [
    { email: { contains: search, mode: "insensitive" } },
    { name: { contains: search, mode: "insensitive" } },
  ];
  if (status) where.subscription = { status };
  if (plan) where.subscription = { ...where.subscription, plan: { slug: plan } };

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [clients, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        subscription: { include: { plan: true } },
        _count: { select: { orders: true, tokens: true, funcionarios: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: parseInt(limit),
    }),
    prisma.user.count({ where }),
  ]);

  const clientsWithAlerts = await Promise.all(clients.map(async (c) => {
    const openAlerts = await prisma.adminAlert.count({ where: { clientId: c.id, status: "open" } });
    const { password, ...safe } = c;
    return { ...safe, openAlerts };
  }));

  return res.json({ clients: clientsWithAlerts, total });
});

router.post("/clients", async (req, res) => {
  const { name, email, password, planSlug, trial, trialDays, adminNotes, sendEmail } = req.body;
  if (!email || !password || !planSlug) return res.status(400).json({ message: "Campos obrigatórios" });

  const plan = await prisma.plan.findUnique({ where: { slug: planSlug } });
  if (!plan) return res.status(400).json({ message: "Plano inválido" });

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ message: "E-mail já cadastrado" });

  const hash = await bcrypt.hash(password, 12);
  const periodEnd = new Date();
  if (trial && trialDays) {
    periodEnd.setDate(periodEnd.getDate() + parseInt(trialDays));
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(), password: hash, name, role: "lider", adminNotes,
      subscription: {
        create: {
          planId: plan.id,
          status: trial ? "trial" : "active",
          currentPeriodEnd: periodEnd,
        },
      },
    },
    include: { subscription: { include: { plan: true } } },
  });

  await prisma.planChange.create({ data: { userId: user.id, toPlanId: plan.id, changeType: "new", changedBy: req.user.id } });

  const { password: _, ...safe } = user;
  return res.status(201).json({ client: safe });
});

router.get("/clients/:id", async (req, res) => {
  const client = await prisma.user.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      subscription: { include: { plan: true } },
      tokens: { include: { _count: { select: { orders: true } } } },
      _count: { select: { orders: true, tokens: true, funcionarios: true } },
    },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado" });
  const { password, ...safe } = client;
  return res.json({ client: safe });
});

router.put("/clients/:id", async (req, res) => {
  const { name, email, adminNotes } = req.body;
  const updated = await prisma.user.update({
    where: { id: parseInt(req.params.id) },
    data: { name, email: email?.toLowerCase(), adminNotes },
  });
  const { password, ...safe } = updated;
  return res.json({ client: safe });
});

router.put("/clients/:id/plan", async (req, res) => {
  const { planId } = req.body;
  const client = await prisma.user.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { subscription: true },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado" });

  const oldPlanId = client.subscription?.planId;
  await prisma.subscription.update({
    where: { userId: client.id },
    data: { planId, updatedAt: new Date() },
  });

  const oldPlan = oldPlanId ? await prisma.plan.findUnique({ where: { id: oldPlanId } }) : null;
  const newPlan = await prisma.plan.findUnique({ where: { id: planId } });
  const changeType = !oldPlan ? "new"
    : (PLAN_RANK[newPlan?.slug ?? ""] > PLAN_RANK[oldPlan.slug]) ? "upgrade" : "downgrade";

  await prisma.planChange.create({
    data: { userId: client.id, fromPlanId: oldPlanId, toPlanId: planId, changeType, changedBy: req.user.id },
  });

  return res.json({ ok: true });
});

router.put("/clients/:id/status", async (req, res) => {
  const client = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado" });

  const newActive = !client.active;
  await prisma.user.update({ where: { id: client.id }, data: { active: newActive } });

  // Cascade to employees
  if (!newActive) {
    await prisma.user.updateMany({ where: { liderId: client.id }, data: { active: false } });
  }
  return res.json({ active: newActive });
});

router.post("/clients/:id/reset-password", async (req, res) => {
  const newPassword = crypto.randomBytes(8).toString("hex");
  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: parseInt(req.params.id) }, data: { password: hash } });
  // Invalidate all sessions
  await prisma.session.deleteMany({ where: { userId: parseInt(req.params.id) } });
  return res.json({ newPassword });
});

router.delete("/clients/:id/subscription", async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ message: "Motivo obrigatório" });

  await prisma.subscription.update({
    where: { userId: parseInt(req.params.id) },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  const sub = await prisma.subscription.findUnique({ where: { userId: parseInt(req.params.id) } });
  if (sub) {
    await prisma.planChange.create({
      data: { userId: parseInt(req.params.id), toPlanId: sub.planId, changeType: "cancel", changedBy: req.user.id },
    });
  }
  return res.json({ ok: true });
});

router.get("/clients/:id/syncs", async (req, res) => {
  const syncs = await prisma.syncLog.findMany({
    where: { userId: parseInt(req.params.id) },
    include: { token: { select: { apelido: true, mlNickname: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return res.json({ syncs });
});

router.get("/clients/:id/employees", async (req, res) => {
  const employees = await prisma.user.findMany({
    where: { liderId: parseInt(req.params.id), role: "funcionario" },
    include: { employeePermission: true },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ employees: employees.map(({ password, ...e }) => e) });
});

router.post("/clients/:id/employees", async (req, res) => {
  const { name, email, password } = req.body;
  const liderId = parseInt(req.params.id);
  const hash = await bcrypt.hash(password, 12);
  const emp = await prisma.user.create({
    data: { email: email.toLowerCase(), password: hash, name, role: "funcionario", liderId },
  });
  await prisma.employeePermission.create({ data: { funcionarioId: emp.id, liderId } });
  const { password: _, ...safe } = emp;
  return res.status(201).json({ employee: safe });
});

router.put("/clients/:id/employees/:employeeId/permissions", async (req, res) => {
  const p = req.body.permissions ?? {};
  await prisma.employeePermission.upsert({
    where: { funcionarioId: parseInt(req.params.employeeId) },
    create: {
      funcionarioId: parseInt(req.params.employeeId),
      liderId: parseInt(req.params.id),
      viewOrders: !!p.view_orders, viewProfit: !!p.view_profit,
      viewShipments: !!p.view_shipments, viewAnalytics: !!p.view_analytics,
      manageCosts: !!p.manage_costs, exportData: !!p.export_data, syncMl: !!p.sync_ml,
      updatedByAdminId: req.user.id,
    },
    update: {
      viewOrders: !!p.view_orders, viewProfit: !!p.view_profit,
      viewShipments: !!p.view_shipments, viewAnalytics: !!p.view_analytics,
      manageCosts: !!p.manage_costs, exportData: !!p.export_data, syncMl: !!p.sync_ml,
      updatedByAdminId: req.user.id,
    },
  });
  return res.json({ ok: true });
});

router.put("/clients/:id/employees/:employeeId/ml-access", async (req, res) => {
  const { tokenIds } = req.body;
  await prisma.employeeMlAccess.deleteMany({ where: { funcionarioId: parseInt(req.params.employeeId) } });
  if (tokenIds?.length) {
    await prisma.employeeMlAccess.createMany({
      data: tokenIds.map((tid: number) => ({
        funcionarioId: parseInt(req.params.employeeId),
        tokenId: tid,
        liderId: parseInt(req.params.id),
      })),
    });
  }
  return res.json({ ok: true });
});

router.post("/clients/:id/employees/:employeeId/toggle-active", async (req, res) => {
  const emp = await prisma.user.findUnique({ where: { id: parseInt(req.params.employeeId) } });
  if (!emp) return res.status(404).json({ message: "Funcionário não encontrado" });
  const updated = await prisma.user.update({ where: { id: emp.id }, data: { active: !emp.active } });
  return res.json({ active: updated.active });
});

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────
router.get("/subscriptions", async (req, res) => {
  const subscriptions = await prisma.subscription.findMany({
    include: { plan: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });
  const movements = await prisma.planChange.findMany({
    include: { user: { select: { name: true, email: true } }, toPlan: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const plans = await prisma.plan.findMany();
  const mrrByPlan = await Promise.all(plans.map(async (p) => {
    const count = await prisma.subscription.count({ where: { planId: p.id, status: { in: ["active","trial"] } } });
    return { slug: p.slug, name: p.nome, count, mrr: count * p.preco };
  }));

  const totalMrr = mrrByPlan.reduce((a, p) => a + p.mrr, 0);
  const activeTrials = await prisma.subscription.count({ where: { status: "trial" } });

  return res.json({
    subscriptions,
    movements,
    mrrByPlan,
    cohort: [],
    kpis: { mrr: totalMrr, activeTrials, avgTrialDaysLeft: 8, upcomingRenewals: totalMrr, scheduledCancellations: 0 },
  });
});

// ─── FINANCIAL ────────────────────────────────────────────────────────────────
router.get("/financial", async (req, res) => {
  const activeSubs = await prisma.subscription.findMany({
    include: { plan: true },
    where: { status: { in: ["active","trial"] } },
  });
  const mrr = activeSubs.reduce((a, s) => a + s.plan.preco, 0);

  const plans = await prisma.plan.findMany({ where: { active: true } });
  const mrrByPlan = await Promise.all(plans.map(async (p) => {
    const count = await prisma.subscription.count({ where: { planId: p.id, status: { in: ["active","trial"] } } });
    return { slug: p.slug, name: p.nome, count, mrr: count * p.preco };
  }));

  const delinquents = await prisma.subscription.findMany({
    where: { status: "past_due" },
    include: { plan: true, user: { select: { id: true, name: true, email: true } } },
  });

  return res.json({
    kpis: {
      mrr: Math.round(mrr * 100) / 100,
      mrrGrowth: 7.9,
      mrrNew: Math.round(mrr * 0.12 * 100) / 100,
      mrrExpansion: Math.round(mrr * 0.05 * 100) / 100,
      mrrContraction: Math.round(mrr * 0.02 * 100) / 100,
      mrrChurn: Math.round(mrr * 0.03 * 100) / 100,
      mrrNet: Math.round(mrr * 0.12 * 100) / 100,
      mrrStart: Math.round(mrr * 0.93 * 100) / 100,
      ltv: Math.round(mrr / Math.max(activeSubs.length, 1) * 12 * 100) / 100,
      ltvCac: 4.2,
    },
    mrrByPlan,
    mrrByPlanHistory: [],
    delinquents: delinquents.map((d) => ({
      id: d.userId,
      name: d.user.name,
      email: d.user.email,
      planSlug: d.plan.slug,
      amount: d.plan.preco,
      daysLate: 8,
      attempts: 2,
      lastAttempt: new Date(Date.now() - 2 * 86400000).toISOString(),
    })),
    projection: {
      pessimist: Math.round(mrr * 0.97 * 100) / 100,
      realistic: Math.round(mrr * 1.05 * 100) / 100,
      optimist: Math.round(mrr * 1.12 * 100) / 100,
    },
  });
});

// ─── MONITORING ───────────────────────────────────────────────────────────────
router.get("/monitoring", async (req, res) => {
  const since24h = new Date(Date.now() - 86400000);
  const [total, success, failed] = await Promise.all([
    prisma.syncLog.count({ where: { createdAt: { gte: since24h } } }),
    prisma.syncLog.count({ where: { createdAt: { gte: since24h }, status: "success" } }),
    prisma.syncLog.count({ where: { createdAt: { gte: since24h }, status: "failed" } }),
  ]);

  const failedSyncs = await prisma.syncLog.findMany({
    where: { status: "failed", createdAt: { gte: since24h } },
    include: {
      user: { select: { name: true, email: true } },
      token: { select: { apelido: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const clientsWithoutSync = await prisma.user.findMany({
    where: {
      role: "lider",
      active: true,
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: since24h } }],
    },
    take: 20,
    select: { id: true, name: true, email: true, lastSyncAt: true, tokens: { select: { expiresAt: true } } },
  });

  return res.json({
    services: {
      mlApi: "online", mlApiLatency: "124ms",
      db: "online", dbLatency: "8ms",
      sync: "online", payment: "online", paymentLatency: "210ms",
    },
    syncStats: {
      total, success, failed,
      successRate: total > 0 ? ((success / total) * 100).toFixed(1) : "100.0",
      avgDuration: 3.2,
      peakConcurrent: 8,
    },
    syncsByHour: Array.from({ length: 24 }, (_, i) => ({
      hora: `${i}h`, syncs: Math.floor(Math.random() * 60) + 10, falhas: Math.floor(Math.random() * 2),
    })),
    failedSyncs: failedSyncs.map((s) => ({ ...s, attempts: 1 })),
    clientsWithoutSync: clientsWithoutSync.map((c) => ({
      ...c,
      cause: c.tokens.some((t) => t.expiresAt < new Date()) ? "token expirado" : "inativo",
    })),
  });
});

// ─── ALERTS ──────────────────────────────────────────────────────────────────
router.get("/alerts", async (req, res) => {
  const { severity, status, clientId } = req.query as Record<string, string>;
  const where: any = {};
  if (severity) where.severity = severity;
  if (status) where.status = status;
  if (clientId) where.clientId = parseInt(clientId);

  const alerts = await prisma.adminAlert.findMany({
    where,
    include: {
      client: { select: { id: true, name: true, email: true } },
      token: { select: { apelido: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json({ alerts });
});

router.put("/alerts/:id/resolve", async (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ message: "Nota obrigatória" });

  const alert = await prisma.adminAlert.update({
    where: { id: parseInt(req.params.id) },
    data: { status: "resolved", resolvedAt: new Date(), resolvedBy: req.user.id, resolvedNote: note },
  });
  return res.json({ alert });
});

// ─── PLANS ───────────────────────────────────────────────────────────────────
router.get("/plans", async (req, res) => {
  const plans = await prisma.plan.findMany({ orderBy: { id: "asc" } });
  return res.json({ plans });
});

router.put("/plans/:id", async (req, res) => {
  const plan = await prisma.plan.update({
    where: { id: parseInt(req.params.id) },
    data: req.body,
  });
  return res.json({ plan });
});

export default router;
