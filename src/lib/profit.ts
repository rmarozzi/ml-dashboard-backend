import prisma from "./prisma";

async function getEffectiveTaxRate(userId: number, date: Date): Promise<number> {
  const setting = await prisma.taxSetting.findFirst({
    where: { userId, validFrom: { lte: date } },
    orderBy: { validFrom: "desc" },
  });
  return setting?.rate ?? 0;
}

export async function calculateOrderProfit(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true, shipment: true },
  }) as any;
  if (!order) return null;

  const grossRevenue = order.totalAmount;

  const mlFee = order.items.reduce(
    (acc: number, item: any) => acc + (item.saleFee ?? 0) * item.quantity, 0
  );

  const shippingCost = order.shippingCost ?? order.shipment?.cost ?? 0;
  const mlTax = order.taxesAmount > 0 ? order.taxesAmount : 0;

  // Estorno = apenas pagamentos extras reais (não inclui desconto de frete do comprador)
  const estorno = order.payments
    .filter((p: any) => p.operationType !== "regular_payment")
    .reduce((acc: number, p: any) => acc + (p.totalPaidAmount ?? 0), 0);

  // Imposto NF = alíquota global do cliente (efetiva na data do pedido) × receita bruta
  const taxRate = await getEffectiveTaxRate(order.userId, order.dateCreated);
  const nfTaxTotal = grossRevenue * (taxRate / 100);

  // Custo do Produto (efetivo na data do pedido, por SKU)
  let productCostTotal = 0;
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
  }

  const profit = grossRevenue - mlFee - shippingCost - nfTaxTotal - productCostTotal - mlTax + estorno;
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
    taxRate,
  };
}