// src/sync/adapters/MercadoLivreAdapter.ts

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

  private client(accessToken: string) {
    return axios.create({
      baseURL: ML_BASE,
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
  }

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
          sort:   "date_desc",
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
        const normalized = await this.normalizeSingle(res.data, account, http);
        if (normalized) results.push(normalized);
      } catch (err: any) {
        console.error(`[ML][Tier2] Erro ao buscar pedido ${orderId}:`, err?.message);
      }
    }

    return results;
  }

  // ─── BUSCA DETALHES COMPLETOS DO PEDIDO ──────────────────────────────────────
  // GET /orders/{id} — dados completos do pedido

  private async fetchOrderDetail(
    http: ReturnType<typeof this.client>,
    orderId: string
  ): Promise<any | null> {
    try {
      const res = await http.get(`/orders/${orderId}`);
      return res.data ?? null;
    } catch {
      return null;
    }
  }

  // ─── BUSCA BILLING INFO (CPF/CNPJ) ───────────────────────────────────────────
  // GET /orders/{id}/billing_info com x-version: 2
  // Retorna CPF/CNPJ e nome fiscal do comprador

  private async fetchBillingInfo(
    http: ReturnType<typeof this.client>,
    orderId: string
  ): Promise<{ docType: string | null; docNumber: string | null; name: string | null }> {
    try {
      const res = await http.get(`/orders/${orderId}/billing_info`, {
        headers: { "x-version": "2" },
      });
      const billing = res.data?.buyer?.billing_info;
      return {
        docType:   billing?.identification?.type ?? billing?.doc_type ?? null,
        docNumber: billing?.identification?.number ?? billing?.doc_number ?? null,
        name:      billing?.name ? `${billing.name} ${billing.last_name ?? ""}`.trim() : null,
      };
    } catch {
      return { docType: null, docNumber: null, name: null };
    }
  }

  // ─── BUSCA DADOS DO SHIPMENT ──────────────────────────────────────────────────
  // GET /shipments/{id} com x-format-new: true
  // Retorna endereço de entrega (destination.shipping_address) e tracking

  private async fetchShipmentData(
    http: ReturnType<typeof this.client>,
    shipmentId: string
  ): Promise<{
    city: string | null;
    state: string | null;
    zipCode: string | null;
    trackingNumber: string | null;
    status: string | null;
  }> {
    try {
      const res = await http.get(`/shipments/${shipmentId}`, {
        headers: { "x-format-new": "true" },
      });
      const data = res.data;

      // Novo formato: destination.shipping_address
      // Legado: receiver_address
      const addr = data?.destination?.shipping_address ?? data?.receiver_address ?? null;

      return {
        city:           addr?.city?.name ?? addr?.city ?? null,
        state:          addr?.state?.name ?? addr?.state?.id ?? null,
        zipCode:        addr?.zip_code ?? null,
        trackingNumber: data?.tracking_number ?? null,
        status:         data?.status ?? null,
      };
    } catch {
      return { city: null, state: null, zipCode: null, trackingNumber: null, status: null };
    }
  }

  // ─── BUSCA CUSTO DE FRETE DO VENDEDOR ────────────────────────────────────────
  // GET /shipments/{id}/costs
  // senders[0].cost = custo real pago pelo vendedor após descontos

  private async fetchShipmentCost(
    http: ReturnType<typeof this.client>,
    shipmentId: string
  ): Promise<number | null> {
    try {
      const res = await http.get(`/shipments/${shipmentId}/costs`);
      const data = res.data;
      // Custo do vendedor após descontos
      const sellerCost = data?.senders?.[0]?.cost;
      if (sellerCost != null && sellerCost > 0) return sellerCost;
      // Fallback: gross_amount
      return data?.gross_amount ?? null;
    } catch {
      return null;
    }
  }

  // ─── NORMALIZAÇÃO ────────────────────────────────────────────────────────────

  private async normalizeMany(
    raws: any[],
    account: ChannelAccount,
    http: ReturnType<typeof this.client>
  ): Promise<NormalizedOrder[]> {
    const results: NormalizedOrder[] = [];
    for (const raw of raws) {
      // Busca detalhes completos individualmente
      const detailed = await this.fetchOrderDetail(http, String(raw.id)) ?? raw;
      const normalized = await this.normalizeSingle(detailed, account, http);
      if (normalized) results.push(normalized);
    }
    return results;
  }

  private async normalizeSingle(
    raw: any,
    account: ChannelAccount,
    http?: ReturnType<typeof this.client>
  ): Promise<NormalizedOrder | null> {
    if (!raw?.id) return null;

    const orderId    = String(raw.id);
    const shipmentId = raw.shipping?.id ? String(raw.shipping.id) : null;

    // ── Dados do shipment (endereço + tracking + custo) ──────────────────────
    let buyerCity: string | null      = null;
    let buyerState: string | null     = null;
    let trackingNumber: string | null = null;
    let shippingCost: number | null   = null;
    let shipmentStatus: string | null = null;

    if (shipmentId && http) {
      const [shipmentData, cost] = await Promise.all([
        this.fetchShipmentData(http, shipmentId),
        this.fetchShipmentCost(http, shipmentId),
      ]);
      buyerCity      = shipmentData.city;
      buyerState     = shipmentData.state;
      trackingNumber = shipmentData.trackingNumber;
      shipmentStatus = shipmentData.status;
      shippingCost   = cost;
    }

    // ── Rateio de frete por pack ─────────────────────────────────────────────
    if (raw.pack_id && shippingCost != null) {
      shippingCost = await this.getProportionalShippingCost(
        String(raw.pack_id),
        orderId,
        shippingCost
      );
    }

    // ── Billing info (CPF/CNPJ) via endpoint dedicado ────────────────────────
    // billing_info no objeto do pedido pode estar vazio — endpoint dedicado
    // retorna dados mais completos com x-version: 2
    let buyerDocType: string | null   = raw.billing_info?.doc_type ?? null;
    let buyerDocNumber: string | null = raw.billing_info?.doc_number ?? null;

    if (http && (!buyerDocType || !buyerDocNumber)) {
      const billing = await this.fetchBillingInfo(http, orderId);
      buyerDocType   = billing.docType   ?? buyerDocType;
      buyerDocNumber = billing.docNumber ?? buyerDocNumber;
    }

    // ── Itens ────────────────────────────────────────────────────────────────
    const items: NormalizedItem[] = (raw.order_items ?? []).map((i: any) => ({
      externalItemId: i.item?.id ?? null,
      title:          i.item?.title ?? "",
      quantity:       i.quantity ?? 1,
      unitPrice:      i.unit_price ?? 0,
      sku:            i.item?.seller_sku ?? null,
      saleFee:        i.sale_fee ?? 0,
    }));

    // ── Pagamentos ───────────────────────────────────────────────────────────
    const payments: NormalizedPayment[] = (raw.payments ?? []).map((p: any) => ({
      externalPaymentId: p.id ? String(p.id) : null,
      status:            p.status ?? "",
      totalPaidAmount:   p.total_paid_amount ?? 0,
      taxesAmount:       p.taxes_amount ?? 0,
      operationType:     p.operation_type ?? "regular_payment",
      paymentMethodId:   p.payment_method_id ?? null,
      moneyReleaseDate:  p.money_release_date ? new Date(p.money_release_date) : null,
    }));

    // ── Shipment ─────────────────────────────────────────────────────────────
    let shipment: NormalizedShipment | null = null;
    if (shipmentId) {
      shipment = {
        externalShipmentId: shipmentId,
        status:             shipmentStatus ?? raw.shipping?.status ?? "",
        trackingNumber,
        cost:               shippingCost,
      };
    }

    return {
      externalOrderId:  orderId,
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
      buyerDocType,
      buyerDocNumber,
      buyerCity,
      buyerState,
      packId: raw.pack_id ? String(raw.pack_id) : null,
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