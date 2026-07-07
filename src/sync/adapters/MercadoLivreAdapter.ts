// src/sync/adapters/MercadoLivreAdapter.ts
//
// Adapter do Mercado Livre para o SyncEngine.
// Encapsula toda a lógica específica do ML: paginação por offset,
// limite de 10k registros, rateio de frete por pack, refresh de token.

import { encrypt, decrypt } from "../../lib/crypto";
import axios from "axios";
import prisma from "../../lib/prisma";
import { ChannelAccount, ChannelType } from "@prisma/client";
import {
  ChannelSyncAdapter,
  NormalizedOrder,
  NormalizedItem,
  NormalizedPayment,
  NormalizedShipment,
  TokenPair,
} from "../types";

const ML_BASE = "https://api.mercadolibre.com";
const CLIENT_ID = process.env.ML_CLIENT_ID!;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET!;

const refreshInFlight = new Map<string, Promise<TokenPair>>();

export class MercadoLivreAdapter implements ChannelSyncAdapter {
  readonly channelType = ChannelType.MERCADO_LIVRE;

  // ─── HTTP CLIENT ────────────────────────────────────────────────────────────

  private client(accessToken: string) {
    return axios.create({
      baseURL: ML_BASE,
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
  }

  // ─── TOKEN ──────────────────────────────────────────────────────────────────

  async refreshTokenForAccount(account: ChannelAccount): Promise<TokenPair> {
    if (refreshInFlight.has(account.id)) {
      return refreshInFlight.get(account.id)!;
    }
    const promise = this._doRefresh(account).finally(() =>
      refreshInFlight.delete(account.id)
    );
    refreshInFlight.set(account.id, promise);
    return promise;
  }

  private async _doRefresh(account: ChannelAccount): Promise<TokenPair> {
    const refreshToken = decrypt(account.refreshTokenEnc);
    const res = await axios.post(`${ML_BASE}/oauth/token`, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    const tokenPair: TokenPair = {
      accessToken:  res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresAt:    new Date(Date.now() + res.data.expires_in * 1000),
    };
    await prisma.channelAccount.update({
      where: { id: account.id },
      data: {
        accessTokenEnc:  encrypt(tokenPair.accessToken),
        refreshTokenEnc: encrypt(tokenPair.refreshToken),
        tokenExpiresAt:  tokenPair.expiresAt,
      },
    });
    console.log(`[ML] Token renovado para conta ${account.id}. Expira: ${tokenPair.expiresAt.toISOString()}`);
    return tokenPair;
  }

  private async getAccessToken(account: ChannelAccount): Promise<string> {
    const expiresInMs = account.tokenExpiresAt.getTime() - Date.now();
    if (expiresInMs < 60 * 60 * 1000) {
      const refreshed = await this.refreshTokenForAccount(account);
      return refreshed.accessToken;
    }
    return decrypt(account.accessTokenEnc);
  }

  // ─── TIER 0 — BACKFILL ──────────────────────────────────────────────────────

  async *backfillHistorical(
    account: ChannelAccount,
    since?: Date
  ): AsyncGenerator<NormalizedOrder[]> {
    const accessToken = await this.getAccessToken(account);
    const http = this.client(accessToken);

    let offset = 0;
    const limit = 50;
    const MAX_OFFSET = 9950;

    while (true) {
      if (offset > MAX_OFFSET) {
        console.warn(`[ML][Tier0] Limite de offset atingido (${offset}). Encerrando paginação.`);
        break;
      }

      const res = await http.get("/orders/search", {
        params: {
          seller: account.externalAccountId,
          sort: "date_desc",
          offset,
          limit,
        },
      });

      const results: any[] = res.data?.results ?? [];
      if (results.length === 0) break;

      const normalized = await this.normalizeMany(results, account, http);
      if (normalized.length > 0) yield normalized;

      if (results.length < limit) break;
      offset += limit;
    }
  }

  // ─── TIER 1 — INCREMENTAL ───────────────────────────────────────────────────

  async *discoverUpdatedOrders(
    account: ChannelAccount,
    since: Date,
    until: Date
  ): AsyncGenerator<NormalizedOrder[]> {
    const accessToken = await this.getAccessToken(account);
    const http = this.client(accessToken);

    let offset = 0;
    const limit = 50;
    const MAX_OFFSET = 9950;

    while (true) {
      if (offset > MAX_OFFSET) {
        console.warn(`[ML][Tier1] Limite de offset atingido. Encerrando janela.`);
        break;
      }

      const res = await http.get("/orders/search", {
        params: {
          seller:                         account.externalAccountId,
          "order.date_last_updated.from": since.toISOString(),
          "order.date_last_updated.to":   until.toISOString(),
          sort:                           "date_last_updated_asc",
          offset,
          limit,
        },
      });

      const results: any[] = res.data?.results ?? [];
      if (results.length === 0) break;

      const normalized = await this.normalizeMany(results, account, http);
      if (normalized.length > 0) yield normalized;

      if (results.length < limit) break;
      offset += limit;
    }
  }

  // ─── TIER 2 — RECHECK ───────────────────────────────────────────────────────

  async recheckOrders(
    account: ChannelAccount,
    externalOrderIds: string[]
  ): Promise<NormalizedOrder[]> {
    const accessToken = await this.getAccessToken(account);
    const http = this.client(accessToken);
    const results: NormalizedOrder[] = [];

    for (const orderId of externalOrderIds) {
      try {
        const res = await http.get(`/orders/${orderId}`);
        const normalized = await this.normalizeSingle(res.data, account);
        if (normalized) results.push(normalized);
      } catch (err: any) {
        console.error(`[ML][Tier2] Erro ao buscar pedido ${orderId}:`, err?.message);
      }
    }

    return results;
  }

  // ─── BUSCA DETALHES EM LOTE ──────────────────────────────────────────────────
  // /orders/search retorna resumo — /orders?ids=... retorna dados completos
  // incluindo shipping.receiver_address, billing_info e payments detalhados

  private async fetchOrderDetails(
    http: ReturnType<typeof this.client>,
    orderIds: string[]
  ): Promise<any[]> {
    if (orderIds.length === 0) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < orderIds.length; i += 50) {
      chunks.push(orderIds.slice(i, i + 50));
    }

    const results: any[] = [];
    for (const chunk of chunks) {
      try {
        const res = await http.get("/orders", {
          params: { ids: chunk.join(",") },
        });
        const data = res.data;
        if (Array.isArray(data)) {
          results.push(...data);
        } else if (data?.results) {
          results.push(...data.results);
        }
      } catch (err: any) {
        console.error(`[ML] Erro ao buscar detalhes em lote:`, err?.message);
      }
    }
    return results;
  }

  // ─── NORMALIZAÇÃO ────────────────────────────────────────────────────────────

  private async normalizeMany(
    raws: any[],
    account: ChannelAccount,
    http: ReturnType<typeof this.client>
  ): Promise<NormalizedOrder[]> {
    // Busca detalhes completos em lote para ter shipping, billing_info, payments
    const orderIds = raws.map((r) => String(r.id));
    const detailedOrders = await this.fetchOrderDetails(http, orderIds);

    const detailMap = new Map<string, any>();
    for (const order of detailedOrders) {
      if (order?.id) detailMap.set(String(order.id), order);
    }

    const results: NormalizedOrder[] = [];
    for (const raw of raws) {
      // Usa detalhes completos se disponível, senão usa o resumo
      const detailed = detailMap.get(String(raw.id)) ?? raw;
      const normalized = await this.normalizeSingle(detailed, account);
      if (normalized) results.push(normalized);
    }
    return results;
  }

  private async normalizeSingle(
    raw: any,
    account: ChannelAccount
  ): Promise<NormalizedOrder | null> {
    if (!raw?.id) return null;

    let shippingCost = raw.shipping?.cost ?? null;
    if (raw.pack_id && shippingCost != null) {
      shippingCost = await this.getProportionalShippingCost(
        String(raw.pack_id),
        String(raw.id),
        shippingCost
      );
    }

    const items: NormalizedItem[] = (raw.order_items ?? []).map((i: any) => ({
      externalItemId: i.item?.id ?? null,
      title:          i.item?.title ?? "",
      quantity:       i.quantity ?? 1,
      unitPrice:      i.unit_price ?? 0,
      sku:            i.item?.seller_sku ?? null,
      saleFee:        i.sale_fee ?? 0,
    }));

    const payments: NormalizedPayment[] = (raw.payments ?? []).map((p: any) => ({
      externalPaymentId: p.id ? String(p.id) : null,
      status:            p.status ?? "",
      totalPaidAmount:   p.total_paid_amount ?? 0,
      taxesAmount:       p.taxes_amount ?? 0,
      operationType:     p.operation_type ?? "regular_payment",
      paymentMethodId:   p.payment_method_id ?? null,
      moneyReleaseDate:  p.money_release_date ? new Date(p.money_release_date) : null,
    }));

    let shipment: NormalizedShipment | null = null;
    if (raw.shipping?.id) {
      shipment = {
        externalShipmentId: String(raw.shipping.id),
        status:             raw.shipping.status ?? "",
        trackingNumber:     raw.shipping.tracking_number ?? null,
        cost:               shippingCost,
      };
    }

    return {
      externalOrderId:  String(raw.id),
      channelAccountId: account.id,
      userId:           account.userId,
      channelType:      ChannelType.MERCADO_LIVRE,
      status:           raw.status ?? "",
      dateCreated:      new Date(raw.date_created),
      dateLastUpdated:  new Date(raw.last_updated ?? raw.date_created),
      totalAmount:      raw.total_amount ?? 0,
      netReceived:      raw.payments?.[0]?.net_received_amount ?? null,
      taxesAmount:      raw.taxes?.amount ?? 0,
      shippingCost,
      shippingDiscount: raw.shipping?.shipping_discount ?? 0,
      buyerName:        raw.buyer?.nickname ?? null,
      buyerDocType:     raw.billing_info?.doc_type ?? null,
      buyerDocNumber:   raw.billing_info?.doc_number ?? null,
      buyerCity:        raw.shipping?.receiver_address?.city?.name ?? null,
      buyerState:       raw.shipping?.receiver_address?.state?.name ?? null,
      packId:           raw.pack_id ? String(raw.pack_id) : null,
      items,
      payments,
      shipment,
    };
  }

  // ── Rateio de frete por pack ─────────────────────────────────────────────────

  private async getProportionalShippingCost(
    packId: string,
    orderId: string,
    fullCost: number
  ): Promise<number> {
    try {
      const existing = await prisma.order.findMany({
        where: { packId },
        select: { externalOrderId: true, totalAmount: true },
      });

      if (existing.length <= 1) return fullCost;

      const thisOrder = existing.find((o) => o.externalOrderId === orderId);
      if (!thisOrder) return fullCost;

      const totalPackAmount = existing.reduce((acc, o) => acc + o.totalAmount, 0);
      if (totalPackAmount === 0) return fullCost;

      return (thisOrder.totalAmount / totalPackAmount) * fullCost;
    } catch {
      return fullCost;
    }
  }
}