import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";

const router = Router();

router.get("/", requireAuth, requireFuncionarioPermission("view_shipments"), async (req, res) => {
  const {
    search, status, page = "1", limit = "50",
    sortField = "dateCreated", sortDir = "desc",
    costMin, costMax,
  } = req.query as Record<string, string>;

  const tokenIds = await filterMlAccounts(req.user);

  const where: any = { order: { tokenId: { in: tokenIds } } };
  if (status) where.status = status;
  if (search) {
    where.mlShipmentId = { contains: search, mode: "insensitive" };
  }
  if (costMin || costMax) {
    where.cost = {};
    if (costMin) where.cost.gte = parseFloat(costMin);
    if (costMax) where.cost.lte = parseFloat(costMax);
  }

  const pageNum = parseInt(page);
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const skip = (pageNum - 1) * limitNum;

  const dbSortFields = ["dateCreated", "status", "cost"];
  const orderBy: any = dbSortFields.includes(sortField)
    ? { [sortField]: sortDir === "asc" ? "asc" : "desc" }
    : { dateCreated: "desc" };

  const total = await prisma.shipment.count({ where });

  const shipments = await prisma.shipment.findMany({
    where,
    include: {
      order: {
        include: { token: { select: { apelido: true, mlNickname: true } } },
      },
    },
    orderBy,
    skip,
    take: limitNum,
  });

  return res.json({
    shipments: shipments.map((s) => ({
      ...s,
      token: s.order.token,
    })),
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum),
  });
});

export default router;