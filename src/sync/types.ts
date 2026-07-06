// src/sync/types.ts
//
// Contratos compartilhados entre o SyncEngine e todos os adapters de canal.
// Nenhum adapter importa detalhes de outro — só este arquivo e o prisma client.

import { ChannelAccount, ChannelType } from "@prisma/client";

export { ChannelAccount, ChannelType };

// ─── TOKEN ────────────────────────────────────────────────────────────────────

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// ─── PEDIDO NORMALIZADO ───────────────────────────────────────────────────────
// Formato interno unificado que todos os adapters devem produzir.
// O SyncEngine persiste apenas este formato — nunca o raw de cada canal.

export interface NormalizedOrder {
  // Identificação
  externalOrderId: string;       // ID do pedido na plataforma (mlId, shopee order_sn, etc.)
  channelAccountId: string;      // FK para ChannelAccount
  userId: number;                // FK para User (desnormalizado para facilitar queries)
  channelType: ChannelType;

  // Status e datas
  status: string;
  dateCreated: Date;
  dateLastUpdated: Date;

  // Valores financeiros
  totalAmount: number;
  netReceived: number | null;
  taxesAmount: number;
  shippingCost: number | null;
  shippingDiscount: number;

  // Comprador
  buyerName: string | null;
  buyerDocType: string | null;
  buyerDocNumber: string | null;
  buyerCity: string | null;
  buyerState: string | null;

  // Pack (ML-specific, ignorado em outros canais)
  packId: string | null;

  // Itens, pagamentos e envio
  items: NormalizedItem[];
  payments: NormalizedPayment[];
  shipment: NormalizedShipment | null;
}

export interface NormalizedItem {
  externalItemId: string | null;
  title: string;
  quantity: number;
  unitPrice: number;
  sku: string | null;
  saleFee: number;
}

export interface NormalizedPayment {
  externalPaymentId: string | null;
  status: string;
  totalPaidAmount: number;
  taxesAmount: number;
  operationType: string;
  paymentMethodId: string | null;
  moneyReleaseDate: Date | null;
}

export interface NormalizedShipment {
  externalShipmentId: string | null;
  status: string;
  trackingNumber: string | null;
  cost: number | null;
}

// ─── ADAPTER INTERFACE ────────────────────────────────────────────────────────

export interface ChannelSyncAdapter {
  readonly channelType: ChannelType;

  /**
   * Tier 0 — Backfill histórico completo.
   * Gerador assíncrono: cada yield retorna um lote de pedidos normalizados.
   * O adapter é responsável por paginar internamente respeitando os limites
   * da plataforma (offset cap do ML, janela de 15 dias da Shopee, etc.).
   */
  backfillHistorical(
    account: ChannelAccount,
    since?: Date
  ): AsyncGenerator<NormalizedOrder[]>;

  /**
   * Tier 1 — Descoberta incremental.
   * Busca pedidos atualizados entre [since, until].
   * O adapter quebra em sub-janelas se necessário.
   */
  discoverUpdatedOrders(
    account: ChannelAccount,
    since: Date,
    until: Date
  ): AsyncGenerator<NormalizedOrder[]>;

  /**
   * Tier 2 — Recheck direcionado.
   * Reconsulta pedidos específicos (por ID externo) que ainda não assentaram.
   * O adapter agrupa em lotes conforme o limite da plataforma.
   */
  recheckOrders(
    account: ChannelAccount,
    externalOrderIds: string[]
  ): Promise<NormalizedOrder[]>;

  /**
   * Refresh de token OAuth, específico de cada canal.
   * Retorna o novo par de tokens já atualizado.
   */
  refreshTokenForAccount(account: ChannelAccount): Promise<TokenPair>;

  /**
   * Gatilho externo (webhook) — opcional por enquanto.
   * Retorna o externalOrderId afetado, ou null se o payload não for reconhecido.
   * Implementado no futuro quando webhooks forem ativados.
   */
  handleExternalEvent?(
    payload: unknown,
    headers: Record<string, string>
  ): Promise<{ externalOrderId: string } | null>;
}

// ─── RESULTADO DE EXECUÇÃO ────────────────────────────────────────────────────

export interface SyncTierResult {
  ordersFound: number;
  ordersUpserted: number;
  errorDetail?: string;
}