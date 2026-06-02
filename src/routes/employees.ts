import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { getLiderId } from "../lib/filterMlAccounts";

const router = Router();

const PLAN_RANK: Record<string, number> = { bronze: 0, prata: 1, ouro: 2, premium: 3 };

router.get("/", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);

  const employees = await prisma.user.findMany({
    where: { liderId, role: "funcionario" },
    include: {
      employeePermission: true,
      employeeMlAccess: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const lider = await prisma.user.findUnique({
    where: { id: liderId },
    include: { tokens: { select: { id: true } } },
  });
  const totalMlAccounts = lider?.tokens.length ?? 0;

  return res.json({
    employees: employees.map((e) => {
      const { password, ...safe } = e;
      return {
        ...safe,
        employeePermission: e.employeePermission
          ? {
              view_orders: e.employeePermission.viewOrders,
              view_profit: e.employeePermission.viewProfit,
              view_shipments: e.employeePermission.viewShipments,
              view_analytics: e.employeePermission.viewAnalytics,
              manage_costs: e.employeePermission.manageCosts,
              export_data: e.employeePermission.exportData,
              sync_ml: e.employeePermission.syncMl,
            }
          : null,
        mlAccessCount: e.employeeMlAccess.length,
        totalMlAccounts,
      };
    }),
  });
});

// GET /employees/me/permissions
router.get("/me/permissions", requireAuth, async (req, res) => {
  if (req.user.role !== "funcionario") {
    return res.json({
      permissions: {
        view_orders: true, view_profit: true, view_shipments: true,
        view_analytics: true, manage_costs: true, export_data: true, sync_ml: true,
      },
      mlAccountIds: [],
    });
  }

  const perms = await prisma.employeePermission.findUnique({ where: { funcionarioId: req.user.id } });
  const mlAccess = await prisma.employeeMlAccess.findMany({ where: { funcionarioId: req.user.id } });

  return res.json({
    permissions: perms ? {
      view_orders: perms.viewOrders, view_profit: perms.viewProfit,
      view_shipments: perms.viewShipments, view_analytics: perms.viewAnalytics,
      manage_costs: perms.manageCosts, export_data: perms.exportData, sync_ml: perms.syncMl,
    } : null,
    mlAccountIds: mlAccess.map((a) => a.tokenId),
  });
});

router.post("/", requireAuth, async (req, res) => {
  const user = req.user;
  if (user.role === "funcionario") return res.status(403).json({ message: "Sem permissão" });

  const liderId = await getLiderId(user);
  const lider = await prisma.user.findUnique({
    where: { id: liderId },
    include: { subscription: { include: { plan: true } } },
  });

  const plan = lider?.subscription?.plan;
  if (!plan || PLAN_RANK[plan.slug] < 1) {
    return res.status(403).json({ message: "Plano Prata+ necessário para criar funcionários" });
  }

  // Check limit
  const count = await prisma.user.count({ where: { liderId, role: "funcionario", active: true } });
  if (plan.maxFuncionarios !== -1 && count >= plan.maxFuncionarios) {
    return res.status(403).json({ message: "Limite de funcionários atingido", required: plan.maxFuncionarios });
  }

  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "E-mail e senha obrigatórios" });

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ message: "E-mail já cadastrado" });

  const hash = await bcrypt.hash(password, 12);
  const employee = await prisma.user.create({
    data: { email: email.toLowerCase(), password: hash, name, role: "funcionario", liderId },
  });
  await prisma.employeePermission.create({ data: { funcionarioId: employee.id, liderId } });

  const { password: _, ...safe } = employee;
  return res.status(201).json({ employee: safe });
});

router.put("/:id/permissions", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const lider = await prisma.user.findUnique({
    where: { id: liderId },
    include: { subscription: { include: { plan: true } } },
  });
  if (!lider?.subscription?.plan?.granularPermissions && req.user.role !== "admin") {
    return res.status(403).json({ message: "Permissões granulares disponíveis no plano Ouro+" });
  }

  const emp = await prisma.user.findFirst({
    where: { id: parseInt(String(req.params.id)), liderId },
  });
  if (!emp) return res.status(404).json({ message: "Funcionário não encontrado" });

  const p = req.body.permissions ?? {};
  await prisma.employeePermission.upsert({
    where: { funcionarioId: emp.id },
    create: {
      funcionarioId: emp.id, liderId,
      viewOrders: !!p.view_orders, viewProfit: !!p.view_profit,
      viewShipments: !!p.view_shipments, viewAnalytics: !!p.view_analytics,
      manageCosts: !!p.manage_costs, exportData: !!p.export_data, syncMl: !!p.sync_ml,
      updatedByAdminId: req.user.role === "admin" ? req.user.id : null,
    },
    update: {
      viewOrders: !!p.view_orders, viewProfit: !!p.view_profit,
      viewShipments: !!p.view_shipments, viewAnalytics: !!p.view_analytics,
      manageCosts: !!p.manage_costs, exportData: !!p.export_data, syncMl: !!p.sync_ml,
      updatedByAdminId: req.user.role === "admin" ? req.user.id : null,
    },
  });
  return res.json({ ok: true });
});

router.put("/:id/ml-access", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const emp = await prisma.user.findFirst({ where: { id: parseInt(String(req.params.id)), liderId } });
  if (!emp) return res.status(404).json({ message: "Funcionário não encontrado" });

  const { tokenIds } = req.body;
  await prisma.employeeMlAccess.deleteMany({ where: { funcionarioId: emp.id } });
  if (tokenIds?.length) {
    await prisma.employeeMlAccess.createMany({
      data: tokenIds.map((tid: number) => ({ funcionarioId: emp.id, tokenId: tid, liderId })),
    });
  }
  return res.json({ ok: true });
});

router.post("/:id/toggle-active", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const emp = await prisma.user.findFirst({ where: { id: parseInt(String(req.params.id)), liderId } });
  if (!emp) return res.status(404).json({ message: "Funcionário não encontrado" });

  const updated = await prisma.user.update({
    where: { id: emp.id },
    data: { active: !emp.active },
  });
  return res.json({ active: updated.active });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const liderId = await getLiderId(req.user);
  const emp = await prisma.user.findFirst({ where: { id: parseInt(String(req.params.id)), liderId } });
  if (!emp) return res.status(404).json({ message: "Funcionário não encontrado" });

  await prisma.user.delete({ where: { id: emp.id } });
  return res.json({ ok: true });
});

export default router;
