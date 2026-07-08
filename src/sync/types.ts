import { ChannelType } from "@prisma/client";

export interface TokenPair {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    Date;
}

export interface NormalizedItem {
  externalItemId: string | null;
  title:          string;
  quantity:       number;
  unitPrice:      number;
  sku:            string | null;
  saleFee:        number;
}

export interface NormalizedPayment {
  externalPaymentId: string | null;
  status:            string;
  totalPaidAmount:   number;
  netReceivedAmount: number | null;  // vem do Mercado Pago
  taxesAmount:       number;
  operationType:     string;
  paymentMethodId:   string | null;
  installments:      number | null;  // parcelas
  moneyReleaseDate:  Date | null;
}

export interface NormalizedShipment {
  externalShipmentId: string;
  status:             string;
  trackingNumber:     string | null;
  cost:               number | null;
}

export interface NormalizedOrder {
  externalOrderId:  string;
  channelAccountId: string;
  userId:           number;
  channelType:      ChannelType;
  status:           string;
  dateCreated:      Date;
  dateLastUpdated:  Date;
  totalAmount:      number;
  paidAmount:       number | null;   // valor efetivamente pago (pode diferir com cupons)
  netReceived:      number | null;   // valor líquido recebido (vem do Mercado Pago)
  taxesAmount:      number;
  shippingCost:     number | null;
  shippingDiscount: number;
  buyerName:        string | null;   // nome real do billing_info
  buyerNickname:    string | null;   // nickname do ML
  buyerDocType:     string | null;
  buyerDocNumber:   string | null;
  buyerCity:        string | null;
  buyerState:       string | null;
  packId:           string | null;
  items:            NormalizedItem[];
  payments:         NormalizedPayment[];
  shipment:         NormalizedShipment | null;
}

export interface SyncTierResult {
  ordersFound:    number;
  ordersUpserted: number;
  errorDetail?:   string;
}

export interface ChannelSyncAdapter {
  readonly channelType: string;
  backfillHistorical(account: any, since?: Date): AsyncGenerator<NormalizedOrder[]>;
  discoverUpdatedOrders(account: any, since: Date, until: Date): AsyncGenerator<NormalizedOrder[]>;
  recheckOrders(account: any, externalOrderIds: string[]): Promise<NormalizedOrder[]>;
  handleWebhook?(account: any, payload: any): Promise<NormalizedOrder | null>;
}