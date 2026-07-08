import { encrypt, decrypt } from "../../lib/crypto";
import axios, { AxiosInstance } from "axios";
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

const ML_BASE  = "https://api.mercadolibre.com";
const MP_BASE  = "https://api.mercadopago.com";
const CLIENT_ID     = process.env.ML_CLIENT_ID!;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET!;
const SITE_ID       = "MLB";
const CONCURRENCY   = 6;

const refreshInFlight = new Map<string, Promise<TokenPair>>();

// ─── UTILITÁRIOS ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    results.push(...await Promise.all(chunk.map(fn)));
    if (i + concurrency < items.length) await sleep(200);
  }
  return results;
}

// Retry com backoff exponencial para 429 e linear para 5xx
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.response?.status;
      if (attempt < maxRetries && (status === 429 || (status >= 500 && status < 600))) {
        attempt++;
        const wait = status === 429 ? 1000 * Math.pow(2, attempt) : 2000 * attempt;
        console.warn(`[ML] ${status} — tentativa ${attempt}/${maxRetries}, aguardando ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// ─── CACHE DE SHIPMENT ───────────────────────────────────────────────────────

interface ShipmentData {
  status:         string;
  trackingNumber: string | null;
  city:           string | null;
  state:          string | null;
  cost:           number | null;
}

// ─── ADAPTER ────────────────────────────────────────────────────────────────

export class MercadoLivreAdapter implements ChannelSyncAdapter {
  readonly channelType = ChannelType.MERCADO_LIVRE;

  private mlClient(token: string): AxiosInstance {
    return axios.create({ baseURL: ML_BASE, headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  }

  private mpClient(token: string): AxiosInstance {
    return axios.create({ baseURL: MP_BASE, headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  }

  // ─── TOKEN ──────────────────────────────────────────────────────────────────

  async refreshTokenForAccount(account: ChannelAccount): Promise<TokenPair> {
    if (refreshInFlight.has(account.id)) return refreshInFlight.get(account.id)!;
    const promise = this._doRefresh(account).finally(() => refreshInFlight.delete(account.id));
    refreshInFlight.set(account.id, promise);
    return promise;
  }

  private async _doRefresh(account: ChannelAccount): Promise<TokenPair> {
    const res = await axios.post(`${ML_BASE}/oauth/token`, {
      grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: decrypt(account.refreshTokenEnc),
    });
    const pair: TokenPair = {
      accessToken:  res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresAt:    new Date(Date.now() + res.data.expires_in * 1000),
    };
    await prisma.channelAccount.update({
      where: { id: account.id },
      data:  { accessTokenEnc: encrypt(pair.accessToken), refreshTokenEnc: encrypt(pair.refreshToken), tokenExpiresAt: pair.expiresAt },
    });
    console.log(`[ML] Token renovado para conta ${account.id}. Expira: ${pair.expiresAt.toISOString()}`);
    return pair;
  }

  private async getAccessToken(account: ChannelAccount): Promise<string> {
    const expiresIn = account.tokenExpiresAt.getTime() - Date.now();
    if (expiresIn < 60 * 60 * 1000) return (await this.refreshTokenForAccount(account)).accessToken;
    return decrypt(account.accessTokenEnc);
  }

  // ─── TIER 0 — BACKFILL ──────────────────────────────────────────────────────

  async *backfillHistorical(account: ChannelAccount): AsyncGenerator<NormalizedOrder[]> {
    const token  = await this.getAccessToken(account);
    const ml     = this.mlClient(token);
    const mp     = this.mpClient(token);
    let offset   = 0;
    const limit  = 50;

    while (true) {
      if (offset > 9950) {
        console.warn(`[ML][Tier0] Limite de offset atingido. Encerrando.`);
        break;
      }

      const res = await withRetry(() =>
        ml.get("/orders/search", {
          params: { seller: account.externalAccountId, sort: "date_desc", offset, limit },
        })
      );

      const results: any[] = res.data?.results ?? [];
      if (results.length === 0) break;

      const normalized = await this.normalizeMany(results, account, ml, mp);
      if (normalized.length > 0) yield normalized;

      if (results.length < limit) break;
      offset += limit;
    }
  }

  // ─── TIER 1 — INCREMENTAL ───────────────────────────────────────────────────

  async *discoverUpdatedOrders(account: ChannelAccount, since: Date, until: Date): AsyncGenerator<NormalizedOrder[]> {
    const token  = await this.getAccessToken(account);
    const ml     = this.mlClient(token);
    const mp     = this.mpClient(token);
    let offset   = 0;
    const limit  = 50;

    while (true) {
      if (offset > 9950) break;

      const res = await withRetry(() =>
        ml.get("/orders/search", {
          params: {
            // Sem seller — token já identifica o vendedor
            // Passar seller + filtros de data causa erro 400/403
            "order.date_last_updated.from": since.toISOString(),
            "order.date_last_updated.to":   until.toISOString(),
            sort: "date_last_updated_asc", offset, limit,
          },
        })
      );

      const results: any[] = res.data?.results ?? [];
      if (results.length === 0) break;

      const normalized = await this.normalizeMany(results, account, ml, mp);
      if (normalized.length > 0) yield normalized;

      if (results.length < limit) break;
      offset += limit;
    }
  }

  // ─── TIER 2 — RECHECK ───────────────────────────────────────────────────────

  async recheckOrders(account: ChannelAccount, externalOrderIds: string[]): Promise<NormalizedOrder[]> {
    const token = await this.getAccessToken(account);
    const ml    = this.mlClient(token);
    const mp    = this.mpClient(token);

    const raws = await runWithConcurrency(externalOrderIds, CONCURRENCY, async (id) => {
      try {
        const res = await withRetry(() => ml.get(`/orders/${id}`));
        return res.data ?? null;
      } catch (err: any) {
        console.error(`[ML][Tier2] Erro ao buscar ${id}:`, err?.message);
        return null;
      }
    });

    return this.normalizeMany(raws.filter(Boolean), account, ml, mp);
  }

  // ─── WEBHOOK ─────────────────────────────────────────────────────────────────

  async handleWebhook(account: ChannelAccount, payload: any): Promise<NormalizedOrder | null> {
    const orderId = payload?.resource?.replace("/orders/", "") ?? payload?.id;
    if (!orderId) return null;

    const token = await this.getAccessToken(account);
    const ml    = this.mlClient(token);
    const mp    = this.mpClient(token);

    try {
      const res = await withRetry(() => ml.get(`/orders/${orderId}`));
      const normalized = await this.normalizeSingle(res.data, account, ml, mp, new Map());
      return normalized;
    } catch (err: any) {
      console.error(`[ML][Webhook] Erro ao buscar pedido ${orderId}:`, err?.message);
      return null;
    }
  }

  // ─── NORMALIZAÇÃO ────────────────────────────────────────────────────────────

  private async normalizeMany(
    raws: any[],
    account: ChannelAccount,
    ml: AxiosInstance,
    mp: AxiosInstance
  ): Promise<NormalizedOrder[]> {
    // 1. Busca detalhes completos de cada pedido em paralelo
    const detailed = await runWithConcurrency(raws, CONCURRENCY, async (raw) => {
      try {
        const res = await withRetry(() => ml.get(`/orders/${raw.id}`));
        return res.data ?? raw;
      } catch {
        return raw;
      }
    });

    // 2. Cache de shipment por shipmentId único
    //    Packs compartilham o mesmo shipmentId — busca 1x só
    const uniqueShipmentIds = [...new Set(
      detailed.map((o) => o.shipping?.id).filter(Boolean).map(String)
    )];

    const shipmentCache = new Map<string, ShipmentData>();
    await runWithConcurrency(uniqueShipmentIds, CONCURRENCY, async (shipmentId) => {
      const data = await this.fetchShipmentData(ml, shipmentId);
      shipmentCache.set(shipmentId, data);
    });

    // 3. Normaliza todos com cache compartilhado
    const results = await runWithConcurrency(detailed, CONCURRENCY, async (raw) => {
      return this.normalizeSingle(raw, account, ml, mp, shipmentCache);
    });

    return results.filter((o): o is NormalizedOrder => o !== null);
  }

  private async normalizeSingle(
    raw: any,
    account: ChannelAccount,
    ml: AxiosInstance,
    mp: AxiosInstance,
    shipmentCache: Map<string, ShipmentData>
  ): Promise<NormalizedOrder | null> {
    if (!raw?.id) return null;

    const orderId    = String(raw.id);
    const shipmentId = raw.shipping?.id ? String(raw.shipping.id) : null;

    // ── Shipment (usa cache) ──────────────────────────────────────────────────
    let shipmentData: ShipmentData = { status: "", trackingNumber: null, city: null, state: null, cost: null };
    if (shipmentId) {
      shipmentData = shipmentCache.get(shipmentId) ?? await this.fetchShipmentData(ml, shipmentId);
    }

    // ── Rateio de frete por pack ──────────────────────────────────────────────
    let shippingCost = shipmentData.cost;
    if (raw.pack_id && shippingCost != null) {
      shippingCost = await this.getProportionalShippingCost(String(raw.pack_id), orderId, shippingCost);
    }

    // ── Billing info — nome real + CPF/CNPJ ──────────────────────────────────
    // Novo endpoint: pega billing_info_id do order e consulta o endpoint dedicado
    let buyerName:      string | null = null;
    let buyerDocType:   string | null = null;
    let buyerDocNumber: string | null = null;

    const billingInfoId = raw.buyer?.billing_info?.id ?? raw.billing_info?.id ?? null;
    if (billingInfoId) {
      const billing = await this.fetchBillingInfo(ml, String(billingInfoId));
      buyerName      = billing.name;
      buyerDocType   = billing.docType;
      buyerDocNumber = billing.docNumber;
    }

    // Fallback: billing_info direto no pedido (legado)
    if (!buyerDocType && raw.billing_info?.doc_type) {
      buyerDocType   = raw.billing_info.doc_type;
      buyerDocNumber = raw.billing_info.doc_number ?? null;
    }

    // ── Pagamentos + Mercado Pago ─────────────────────────────────────────────
    const payments: NormalizedPayment[] = await runWithConcurrency(
      raw.payments ?? [],
      CONCURRENCY,
      async (p: any) => {
        let moneyReleaseDate: Date | null  = p.money_release_date ? new Date(p.money_release_date) : null;
        let netReceivedAmount: number | null = p.net_received_amount ?? null;

        // Busca dados detalhados do Mercado Pago quando necessário
        if (p.id && (!moneyReleaseDate || !netReceivedAmount)) {
          const mpData = await this.fetchMercadoPagoPayment(mp, String(p.id));
          if (mpData) {
            moneyReleaseDate  = moneyReleaseDate  ?? (mpData.money_release_date ? new Date(mpData.money_release_date) : null);
            netReceivedAmount = netReceivedAmount ?? mpData.net_amount ?? null;
          }
        }

        return {
          externalPaymentId: p.id ? String(p.id) : null,
          status:            p.status ?? "",
          totalPaidAmount:   p.total_paid_amount ?? 0,
          netReceivedAmount,
          taxesAmount:       p.taxes_amount ?? 0,
          operationType:     p.operation_type ?? "regular_payment",
          paymentMethodId:   p.payment_method_id ?? null,
          installments:      p.installments ?? null,
          moneyReleaseDate,
        };
      }
    );

    // ── Itens ─────────────────────────────────────────────────────────────────
    const items: NormalizedItem[] = (raw.order_items ?? []).map((i: any) => ({
      externalItemId: i.item?.id ?? null,
      title:          i.item?.title ?? "",
      quantity:       i.quantity ?? 1,
      unitPrice:      i.unit_price ?? 0,
      sku:            i.item?.seller_sku ?? null,
      saleFee:        i.sale_fee ?? 0,
    }));

    // ── Shipment ──────────────────────────────────────────────────────────────
    let shipment: NormalizedShipment | null = null;
    if (shipmentId) {
      shipment = {
        externalShipmentId: shipmentId,
        status:             shipmentData.status,
        trackingNumber:     shipmentData.trackingNumber,
        cost:               shippingCost,
      };
    }

    // ── Net received — soma dos pagamentos regulares ───────────────────────────
    const netReceived = payments
      .filter((p) => p.operationType === "regular_payment" && p.netReceivedAmount != null)
      .reduce((acc, p) => acc + (p.netReceivedAmount ?? 0), 0) || null;

    return {
      externalOrderId:  orderId,
      channelAccountId: account.id,
      userId:           account.userId,
      channelType:      ChannelType.MERCADO_LIVRE,
      status:           raw.status ?? "",
      dateCreated:      new Date(raw.date_created),
      dateLastUpdated:  new Date(raw.last_updated ?? raw.date_created),
      totalAmount:      raw.total_amount ?? 0,
      paidAmount:       raw.paid_amount ?? null,
      netReceived,
      taxesAmount:      raw.taxes?.amount ?? 0,
      shippingCost,
      shippingDiscount: raw.shipping?.shipping_discount ?? 0,
      buyerName,
      buyerNickname:    raw.buyer?.nickname ?? null,
      buyerDocType,
      buyerDocNumber,
      buyerCity:        shipmentData.city,
      buyerState:       shipmentData.state,
      packId:           raw.pack_id ? String(raw.pack_id) : null,
      items,
      payments,
      shipment,
    };
  }

  // ─── ENDPOINT: SHIPMENT ──────────────────────────────────────────────────────
  // GET /shipments/{id} com x-format-new: true
  // GET /shipments/{id}/costs para custo do vendedor
  // Ambos em paralelo

  private async fetchShipmentData(ml: AxiosInstance, shipmentId: string): Promise<ShipmentData> {
    const [shipRes, costRes] = await Promise.allSettled([
      withRetry(() => ml.get(`/shipments/${shipmentId}`, { headers: { "x-format-new": "true" } })),
      withRetry(() => ml.get(`/shipments/${shipmentId}/costs`)),
    ]);

    let city: string | null = null, state: string | null = null;
    let trackingNumber: string | null = null, status = "";

    if (shipRes.status === "fulfilled") {
      const d    = shipRes.value.data;
      const addr = d?.destination?.shipping_address ?? d?.receiver_address ?? null;
      city           = addr?.city?.name  ?? addr?.city  ?? null;
      state          = addr?.state?.name ?? addr?.state?.id ?? null;
      trackingNumber = d?.tracking_number ?? null;
      status         = d?.status ?? "";
    }

    let cost: number | null = null;
    if (costRes.status === "fulfilled") {
      const d = costRes.value.data;
      const sellerCost = d?.senders?.[0]?.cost;
      cost = (sellerCost != null && sellerCost > 0) ? sellerCost : (d?.gross_amount ?? null);
    }

    return { status, trackingNumber, city, state, cost };
  }

  // ─── ENDPOINT: BILLING INFO (NOVO) ───────────────────────────────────────────
  // Novo fluxo: billing_info_id vem do /orders no buyer.billing_info.id
  // GET /orders/billing-info/{site_id}/{billing_info_id}
  // Fallback: GET /orders/{id}/billing_info (legado, depreciado)

  private async fetchBillingInfo(
    ml: AxiosInstance,
    billingInfoId: string
  ): Promise<{ name: string | null; docType: string | null; docNumber: string | null }> {
    // Tenta o novo endpoint primeiro
    try {
      const res = await withRetry(() =>
        ml.get(`/orders/billing-info/${SITE_ID}/${billingInfoId}`)
      );
      const data = res.data;
      const fullName = [data?.first_name, data?.last_name].filter(Boolean).join(" ") || data?.name || null;
      return {
        name:      fullName,
        docType:   data?.identification?.type   ?? data?.doc_type   ?? null,
        docNumber: data?.identification?.number ?? data?.doc_number ?? null,
      };
    } catch {
      // Fallback para endpoint legado
      try {
        const res = await withRetry(() =>
          ml.get(`/orders/${billingInfoId}/billing_info`, { headers: { "x-version": "2" } })
        );
        const b = res.data?.buyer?.billing_info ?? res.data;
        const fullName = b?.first_name
          ? [b.first_name, b.last_name].filter(Boolean).join(" ")
          : null;
        return {
          name:      fullName,
          docType:   b?.identification?.type   ?? b?.doc_type   ?? null,
          docNumber: b?.identification?.number ?? b?.doc_number ?? null,
        };
      } catch {
        return { name: null, docType: null, docNumber: null };
      }
    }
  }

  // ─── ENDPOINT: MERCADO PAGO ───────────────────────────────────────────────────
  // GET https://api.mercadopago.com/v1/payments/{id}
  // Retorna money_release_date e net_amount mais confiáveis

  private async fetchMercadoPagoPayment(mp: AxiosInstance, paymentId: string): Promise<any | null> {
    try {
      const res = await withRetry(() => mp.get(`/v1/payments/${paymentId}`));
      return res.data ?? null;
    } catch {
      return null;
    }
  }

  // ─── RATEIO DE FRETE POR PACK ────────────────────────────────────────────────

  private async getProportionalShippingCost(packId: string, orderId: string, fullCost: number): Promise<number> {
    try {
      const orders = await prisma.order.findMany({
        where:  { packId },
        select: { externalOrderId: true, totalAmount: true },
      });
      if (orders.length <= 1) return fullCost;
      const thisOrder = orders.find((o) => o.externalOrderId === orderId);
      if (!thisOrder) return fullCost;
      const total = orders.reduce((acc, o) => acc + o.totalAmount, 0);
      return total === 0 ? fullCost : (thisOrder.totalAmount / total) * fullCost;
    } catch {
      return fullCost;
    }
  }
}