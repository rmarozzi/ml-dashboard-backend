import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";

const router = Router();

router.get("/", requireAuth, requireFuncionarioPermission("view_shipments"), async (req, res) => {
  const {
    search, status, page = "1", limit = "50",
    sortField = "dateCreated", sortDir = "desc",
    costMin, costMax,
  } = req.query as Record<string, string>;

  const liderId = req.user.role === "funcionario" ? req.user.liderId : req.user.id;

  const where: any = { order: { userId: liderId } };

  if (status) where.status = status;
  if (search) {
    where.OR = [
      { externalShipmentId: { contains: search, mode: "insensitive" } },
      { trackingNumber:     { contains: search, mode: "insensitive" } },
    ];
  }
  if (costMin) where.cost = { ...where.cost, gte: parseFloat(costMin) };
  if (costMax) where.cost = { ...where.cost, lte: parseFloat(costMax) };

  const pageNum  = parseInt(page);
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const skip     = (pageNum - 1) * limitNum;

  const validSortFields: Record<string, any> = {
    dateCreated: { order: { dateCreated: sortDir === "asc" ? "asc" : "desc" } },
    status:      { status: sortDir === "asc" ? "asc" : "desc" },
    cost:        { cost:   sortDir === "asc" ? "asc" : "desc" },
  };
  const orderBy = validSortFields[sortField] ?? { order: { dateCreated: "desc" } };

  const [total, shipments] = await Promise.all([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({
      where,
      include: {
        order: {
          select: {
            id:              true,
            mlId:            true,
            externalOrderId: true,
            packId:          true,
            dateCreated:     true,
            channelAccount:  {
              select: { apelido: true, externalNickname: true, channelType: true },
            },
          },
        },
      },
      orderBy,
      skip,
      take: limitNum,
    }),
  ]);

  const result = shipments.map((s) => ({
    id:              s.id,
    mlShipmentId:    s.externalShipmentId,
    status:          s.status,
    trackingNumber:  s.trackingNumber,
    cost:            s.cost,
    dateCreated:     s.order.dateCreated,
    token: {
      apelido:    s.order.channelAccount?.apelido ?? s.order.channelAccount?.externalNickname ?? null,
      mlNickname: s.order.channelAccount?.externalNickname ?? null,
    },
    order: {
      id:    s.order.id,
      mlId:  s.order.packId ?? s.order.mlId ?? s.order.externalOrderId,
    },
  }));

  return res.json({
    shipments:  result,
    total,
    page:       pageNum,
    limit:      limitNum,
    totalPages: Math.ceil(total / limitNum),
  });
});

export default router;