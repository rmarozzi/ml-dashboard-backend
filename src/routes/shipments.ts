import { Router } from "express";
import prisma from "../lib/prisma";
import { requireAuth, requireFuncionarioPermission } from "../middlewares/auth";
import { filterMlAccounts } from "../lib/filterMlAccounts";

const router = Router();

router.get("/", requireAuth, requireFuncionarioPermission("view_shipments"), async (req, res) => {
  const tokenIds = await filterMlAccounts(req.user);

  const shipments = await prisma.shipment.findMany({
    where: { order: { tokenId: { in: tokenIds } } },
    include: { order: { include: { token: { select: { apelido: true, mlNickname: true } } } } },
    orderBy: { dateCreated: "desc" },
    take: 200,
  });

  return res.json({
    shipments: shipments.map((s) => ({
      ...s,
      token: s.order.token,
    })),
  });
});

export default router;
