import prisma from "./prisma";

export async function calculateOrderProfit(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true },
  });
  if (!order) return null;

  // Sum net received from payments
  const netReceived = order.netReceived ?? order.payments.reduce((acc, p) => acc + p.totalPaidAmount, 0);
  const taxesAmount = order.payments.reduce((acc, p) => acc + p.taxesAmount, 0);

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

  const profit = netReceived - productCostTotal - nfTaxTotal - taxesAmount;
  const margin = order.totalAmount > 0 ? (profit / order.totalAmount) * 100 : 0;

  return {
    netReceived,
    productCost: productCostTotal,
    nfTax: nfTaxTotal,
    mlFees: taxesAmount,
    profit,
    margin: parseFloat(margin.toFixed(2)),
    allCostsFound,
  };
}
