import prisma from "./prisma";

export async function calculateOrderProfit(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true, shipment: true },
  });
  if (!order) return null;

  // Receita bruta = valor total do pedido
  const grossRevenue = order.totalAmount;

  // Tarifa ML = soma dos sale_fee de cada item
  const mlFee = order.items.reduce((acc, item) => acc + (item.saleFee ?? 0), 0);

  // Frete cobrado do vendedor
  const shippingCost = order.shipment?.cost ?? 0;

  // Estorno = payments com operationType diferente de regular_payment (ex: reembolso parcial do ML)
  const estorno = order.payments
    .filter(p => p.operationType !== "regular_payment")
    .reduce((acc, p) => acc + p.totalPaidAmount, 0);

  // Custo do produto + imposto NF
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

    const itemCost = cost.cost * item.quantity;
    const itemTax = itemCost * (cost.taxRate / 100);
    productCostTotal += itemCost;
    nfTaxTotal += itemTax;
  }

  // Fórmula final:
  // Lucro = Receita Bruta - Tarifa ML - Frete - Custo Produto - Imposto NF + Estorno
  const profit = grossRevenue - mlFee - shippingCost - productCostTotal - nfTaxTotal + estorno;
  const margin = grossRevenue > 0 ? (profit / grossRevenue) * 100 : 0;

  return {
    grossRevenue,
    mlFee,
    shippingCost,
    estorno,
    productCost: productCostTotal,
    nfTax: nfTaxTotal,
    profit,
    margin: parseFloat(margin.toFixed(2)),
    allCostsFound,
  };
}