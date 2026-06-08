import prisma from "./prisma";

export async function calculateOrderProfit(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true, shipment: true },
  }) as any;
  if (!order) return null;

  // ── Receita Bruta ─────────────────────────────────────────────
  const grossRevenue = order.totalAmount;

  // ── Tarifa ML = soma dos sale_fee dos itens ────────────────────
  const mlFee = order.items.reduce(
    (acc: number, item: any) => acc + (item.saleFee ?? 0), 0
  );

  // ── Frete cobrado do vendedor ──────────────────────────────────
  const shippingCost = order.shippingCost
    ?? order.shipment?.cost
    ?? 0;

  // ── Imposto NF (taxes.amount do ML) ───────────────────────────
  const mlTax = order.taxesAmount ?? 0;

  // ── Estorno = pagamentos que não são regular_payment ──────────
  // Ex: seller_recharge, buyer_insurance, etc.
  const estorno = order.payments
    .filter((p: any) => p.operationType !== "regular_payment")
    .reduce((acc: number, p: any) => acc + (p.totalPaidAmount ?? 0), 0);

  // ── Custo do Produto + Imposto NF do vendedor ──────────────────
  let productCostTotal = 0;
  let nfTaxTotal = 0;
  let allCostsFound = true;

  for (const item of order.items) {
    if (!item.sku) { allCostsFound = false; continue; }

    const cost = await prisma.productCost.findFirst({
      where: {
        userId: order.userId,
        sku: item.sku,
        validFrom: { lte: order.dateCreated },
      },
      orderBy: { validFrom: "desc" },
    });

    if (!cost) { allCostsFound = false; continue; }

    productCostTotal += cost.cost * item.quantity;
    nfTaxTotal += (cost.cost * item.quantity) * (cost.taxRate / 100);
  }

  // ── Fórmula final ──────────────────────────────────────────────
  // Lucro = Receita Bruta - Tarifa ML - Frete - Custo Produto - Imposto NF + Estorno
  const profit = grossRevenue - mlFee - shippingCost - mlTax - productCostTotal - nfTaxTotal + estorno;
  const margin = grossRevenue > 0 ? (profit / grossRevenue) * 100 : 0;

  return {
    grossRevenue,
    mlFee,
    shippingCost,
    mlTax,
    estorno,
    productCost: productCostTotal,
    nfTax: nfTaxTotal,
    profit,
    margin: parseFloat(margin.toFixed(2)),
    allCostsFound,
  };
}