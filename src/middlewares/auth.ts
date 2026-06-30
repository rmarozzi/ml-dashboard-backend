import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";

declare global {
  namespace Express {
    interface Request {
      user?: any;
      sessionToken?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ message: "Não autenticado" });

  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          subscription: { include: { plan: true } },
          lider: { select: { active: true } },
        },
      },
    },
  });

  if (!session || session.expiresAt < new Date()) {
    return res.status(401).json({ message: "Sessão expirada" });
  }

  if (!session.user.active) {
    return res.status(403).json({ message: "Conta desativada" });
  }

  // If funcionario, also check if lider is active
  if (session.user.role === "funcionario" && session.user.lider && !session.user.lider.active) {
    return res.status(403).json({ message: "Conta do responsável desativada" });
  }

  req.user = session.user;
  req.sessionToken = token;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Acesso restrito a administradores" });
  }
  next();
}

const PLAN_RANK: Record<string, number> = { bronze: 0, prata: 1, ouro: 2, premium: 3 };

// Sistema de planos pagos desativado — todos os clientes têm acesso completo.
// As funções abaixo são mantidas para não quebrar as rotas que as utilizam,
// mas não aplicam mais nenhuma restrição.
export function requirePlan(slug: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    next();
  };
}

export function requireFeature(feature: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    next();
  };
}

export function requireFuncionarioPermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (user.role === "admin" || user.role === "lider") return next();

    const perms = await prisma.employeePermission.findUnique({
      where: { funcionarioId: user.id },
    });

    const permMap: Record<string, keyof typeof perms> = {
      view_orders: "viewOrders",
      view_profit: "viewProfit",
      view_shipments: "viewShipments",
      view_analytics: "viewAnalytics",
      manage_costs: "manageCosts",
      export_data: "exportData",
      sync_ml: "syncMl",
    };

    const field = permMap[permission];
    if (!field || !perms || !perms[field]) {
      return res.status(403).json({ message: "Permissão negada", permission });
    }
    next();
  };
}
