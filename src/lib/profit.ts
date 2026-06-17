import prisma from "./prisma";

export async function calculateOrderProfit(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true, shipment: true },
  }) as any;
  if (!order) return null;

  // Receita Bruta
  const grossRevenue = order.totalAmount;

  // Tarifa ML = soma dos sale_fee dos itens
  // sale_fee vem por unidade — multiplica pela quantidade
const mlFee = order.items.reduce(
  (acc: number, item: any) => acc + ((item.saleFee ?? 0) * item.quantity), 0
);

  // Frete cobrado do vendedor
  const shippingCost = order.shippingCost ?? order.shipment?.cost ?? 0;

  // Imposto ML (taxes.amount) — só considerado se > 0
  const mlTax = order.taxesAmount > 0 ? order.taxesAmount : 0;

// Estorno de payments (pagamentos extras do ML)
const paymentEstorno = order.payments
  .filter((p: any) => p.operationType !== "regular_payment")
  .reduce((acc: number, p: any) => acc + (p.totalPaidAmount ?? 0), 0);

// Estorno de frete (desconto que o ML deu no envio)
const shippingDiscount = (order as any).shippingDiscount ?? 0;

const estorno = paymentEstorno + shippingDiscount;

  // Custo do Produto + Imposto NF calculado sobre receita bruta por produto
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

    // Custo do produto
    productCostTotal += cost.cost * item.quantity;

    // Imposto NF = alíquota cadastrada × receita bruta proporcional do item
    const itemRevenue = item.unitPrice * item.quantity;
    nfTaxTotal += itemRevenue * (cost.taxRate / 100);
  }

  // Fórmula final:
  // Lucro = Receita Bruta - Tarifa ML - Frete - Imposto NF - Custo Produto - Imposto ML + Estorno
  const profit = grossRevenue - mlFee - shippingCost - nfTaxTotal - productCostTotal - mlTax + estorno;
  const margin = grossRevenue > 0 ? (profit / grossRevenue) * 100 : 0;

  return {
    grossRevenue,
    mlFee,
    shippingCost,
    mlTax,          // só > 0 quando o ML retiver algo
    estorno,
    productCost: productCostTotal,
    nfTax: nfTaxTotal,  // calculado sobre receita bruta × alíquota do SKU
    profit,
    margin: parseFloat(margin.toFixed(2)),
    allCostsFound,
  };
}