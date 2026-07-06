// src/sync/adapters/ShopeeAdapter.ts
//
// Adapter da Shopee para o SyncEngine.
// Particularidades encapsuladas aqui:
// - Assinatura HMAC-SHA256 em cada request
// - Paginação por cursor (sem limite de offset)
// - Janela máxima de 15 dias por chamada (fatiamento automático)
// - Batch de até 50 order_sn no get_order_detail
// - Access token expira em 4h (refresh automático)

import axios from "axios";
import crypto from "crypto";
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
import { encrypt, decrypt } from "../../lib/crypto";

const SHOPEE_BASE = process.env.NODE_ENV === "production"
  ? "https://openplatform.shopee.com.br"
  : "https://partner.test-stable.shopeemobile.com";
const PARTNER_ID   = parseInt(process.env.SHOPEE_PARTNER_ID!);
const PARTNER_KEY  = process.env.SHOPEE_PARTNER_KEY!;

// Janela máxima permitida pela Shopee por chamada (15 dias em segundos)
const MAX_WINDOW_SECONDS = 15 * 24 * 60 * 60;

// Proteção contra refresh concorrente do mesmo token
const refreshInFlight = new Map<string, Promise<TokenPair>>();

export class ShopeeAdapter implements ChannelSyncAdapter {
  readonly channelType = ChannelType.SHOPEE;

  // ─── ASSINATURA ─────────────────────────────────────────────────────────────

  private sign(path: string, timestamp: number, accessToken = "", shopId = ""): string {
    const base = `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;
    return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
  }

  private buildUrl(path: string, accessToken: string, shopId: string, extraParams: Record<string, any> = {}): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign      = this.sign(path, timestamp, accessToken, shopId);

    const url = new URL(`${SHOPEE_BASE}${path}`);
    url.searchParams.set("partner_id",   String(PARTNER_ID));
    url.searchParams.set("timestamp",    String(timestamp));
    url.searchParams.set("sign",         sign);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("shop_id",      shopId);

    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
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
    const path      = "/api/v2/auth/access_token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign      = this.sign(path, timestamp);

    const res = await axios.post(`${SHOPEE_BASE}${path}`, {
      refresh_token: decrypt(account.refreshTokenEnc),
      shop_id:       parseInt(account.externalAccountId),
      partner_id:    PARTNER_ID,
    }, {
      params: { partner_id: PARTNER_ID, timestamp, sign },
    });

    const { access_token, refresh_token, expire_in } = res.data;
    const tokenPair: TokenPair = {
      accessToken:  access_token,
      refreshToken: refresh_token,
      expiresAt:    new Date(Date.now() + expire_in * 1000),
    };

    await prisma.channelAccount.update({
      where: { id: account.id },
      data: {
        accessTokenEnc:  encrypt(tokenPair.accessToken),
        refreshTokenEnc: encrypt(tokenPair.refreshToken),
        tokenExpiresAt:  tokenPair.expiresAt,
      },
    });

    console.log(`[Shopee] Token renovado para conta ${account.id}. Expira: ${tokenPair.expiresAt.toISOString()}`);
    return tokenPair;
  }

  private async getAccessToken(account: ChannelAccount): Promise<string> {
    const expiresInMs = account.tokenExpiresAt.getTime() - Date.now();
    if (expiresInMs < 30 * 60 * 1000) { // renova se expira em menos de 30min
      const refreshed = await this.refreshTokenForAccount(account);
      return refreshed.accessToken;
    }
    return decrypt(account.accessTokenEnc);
  }

  // ─── FATIAMENTO DE JANELA ────────────────────────────────────────────────────
  // A Shopee limita cada chamada a 15 dias. Se o range for maior,
  // fatia automaticamente em sub-janelas de 15 dias.

  private splitIntoWindows(since: Date, until: Date): Array<{ from: Date; to: Date }> {
    const windows: Array<{ from: Date; to: Date }> = [];
    let cursor = new Date(since);

    while (cursor < until) {
      const windowEnd = new Date(
        Math.min(cursor.getTime() + MAX_WINDOW_SECONDS * 1000, until.getTime())
      );
      windows.push({ from: new Date(cursor), to: windowEnd });
      cursor = windowEnd;
    }
    return windows;
  }

  // ─── TIER 0 — BACKFILL ──────────────────────────────────────────────────────

  async *backfillHistorical(
    account: ChannelAccount,
    since?: Date
  ): AsyncGenerator<NormalizedOrder[]> {
    // Backfill dos últimos 90 dias (limite prático da Shopee pra histórico)
    const until     = new Date();
    const fromDate  = since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const windows   = this.splitIntoWindows(fromDate, until);

    for (const window of windows) {
      yield* this.fetchOrdersInWindow(account, window.from, window.to, "create_time");
    }
  }

  // ─── TIER 1 — INCREMENTAL ───────────────────────────────────────────────────

  async *discoverUpdatedOrders(
    account: ChannelAccount,
    since: Date,
    until: Date
  ): AsyncGenerator<NormalizedOrder[]> {
    const windows = this.splitIntoWindows(since, until);
    for (const window of windows) {
      yield* this.fetchOrdersInWindow(account, window.from, window.to, "update_time");
    }
  }

  // ─── BUSCA PAGINADA POR JANELA ───────────────────────────────────────────────

  private async *fetchOrdersInWindow(
    account: ChannelAccount,
    from: Date,
    to: Date,
    timeRangeField: "create_time" | "update_time"
  ): AsyncGenerator<NormalizedOrder[]> {
    const accessToken = await this.getAccessToken(account);
    const shopId      = account.externalAccountId;

    let cursor: string | undefined = undefined;
    const pageSize = 100;

    while (true) {
      const params: Record<string, any> = {
        time_range_field: timeRangeField,
        time_from:        Math.floor(from.getTime() / 1000),
        time_to:          Math.floor(to.getTime() / 1000),
        page_size:        pageSize,
      };
      if (cursor) params.cursor = cursor;

      const url = this.buildUrl("/api/v2/order/get_order_list", accessToken, shopId, params);
      const res = await axios.get(url);

      const data      = res.data?.response;
      const orderList = data?.order_list ?? [];

      if (orderList.length === 0) break;

      // Busca detalhes em lotes de 50
      const orderSns: string[] = orderList.map((o: any) => o.order_sn);
      const details             = await this.fetchOrderDetails(account, accessToken, shopId, orderSns);
      const normalized          = details.map((d) => this.normalizeSingle(d, account)).filter(Boolean) as NormalizedOrder[];

      if (normalized.length > 0) yield normalized;

      if (!data?.more || !data?.next_cursor) break;
      cursor = data.next_cursor;
    }
  }

  // ─── TIER 2 — RECHECK ───────────────────────────────────────────────────────

  async recheckOrders(
    account: ChannelAccount,
    externalOrderIds: string[]
  ): Promise<NormalizedOrder[]> {
    const accessToken = await this.getAccessToken(account);
    const shopId      = account.externalAccountId;
    const results: NormalizedOrder[] = [];

    // Agrupa em lotes de 50 (limite da Shopee)
    for (let i = 0; i < externalOrderIds.length; i += 50) {
      const batch   = externalOrderIds.slice(i, i + 50);
      const details = await this.fetchOrderDetails(account, accessToken, shopId, batch);
      results.push(
        ...details
          .map((d) => this.normalizeSingle(d, account))
          .filter(Boolean) as NormalizedOrder[]
      );
    }

    return results;
  }

  // ─── BUSCA DETALHES ──────────────────────────────────────────────────────────

  private async fetchOrderDetails(
    account: ChannelAccount,
    accessToken: string,
    shopId: string,
    orderSns: string[]
  ): Promise<any[]> {
    const url = this.buildUrl("/api/v2/order/get_order_detail", accessToken, shopId, {
      order_sn_list:          orderSns.join(","),
      response_optional_fields: "buyer_info,payment_method,shipping_carrier,actual_shipping_fee,items,package_list",
    });

    try {
      const res = await axios.get(url);
      return res.data?.response?.order_list ?? [];
    } catch (err: any) {
      console.error(`[Shopee] Erro ao buscar detalhes:`, err?.response?.data ?? err?.message);
      return [];
    }
  }

  // ─── NORMALIZAÇÃO ────────────────────────────────────────────────────────────

  private normalizeSingle(raw: any, account: ChannelAccount): NormalizedOrder | null {
    if (!raw?.order_sn) return null;

    const items: NormalizedItem[] = (raw.item_list ?? []).map((i: any) => ({
      externalItemId: i.item_id ? String(i.item_id) : null,
      title:          i.item_name ?? "",
      quantity:       i.model_quantity_purchased ?? 1,
      unitPrice:      i.model_discounted_price ?? i.model_original_price ?? 0,
      sku:            i.model_sku || i.item_sku || null,
      saleFee:        0, // Shopee não retorna saleFee direto no pedido
    }));

    const payments: NormalizedPayment[] = raw.payment_method ? [{
      externalPaymentId: raw.order_sn, // Shopee não tem payment_id separado
      status:            raw.order_status ?? "",
      totalPaidAmount:   raw.total_amount ?? 0,
      taxesAmount:       0,
      operationType:     "regular_payment",
      paymentMethodId:   raw.payment_method ?? null,
      moneyReleaseDate:  raw.actual_shipping_fee_confirmed
        ? new Date(raw.pay_time * 1000)
        : null,
    }] : [];

    let shipment: NormalizedShipment | null = null;
    if (raw.shipping_carrier || raw.package_list?.[0]?.tracking_no) {
      shipment = {
        externalShipmentId: raw.package_list?.[0]?.package_number ?? null,
        status:             raw.order_status ?? "",
        trackingNumber:     raw.package_list?.[0]?.tracking_no ?? null,
        cost:               raw.actual_shipping_fee ?? null,
      };
    }

    return {
      externalOrderId:  raw.order_sn,
      channelAccountId: account.id,
      userId:           account.userId,
      channelType:      ChannelType.SHOPEE,
      status:           raw.order_status ?? "",
      dateCreated:      new Date(raw.create_time * 1000),
      dateLastUpdated:  new Date(raw.update_time * 1000),
      totalAmount:      raw.total_amount ?? 0,
      netReceived:      raw.estimated_shipping_fee
        ? raw.total_amount - raw.estimated_shipping_fee
        : null,
      taxesAmount:      0,
      shippingCost:     raw.actual_shipping_fee ?? raw.estimated_shipping_fee ?? null,
      shippingDiscount: 0,
      buyerName:        raw.buyer_info?.buyer_username ?? null,
      buyerDocType:     null,
      buyerDocNumber:   null,
      buyerCity:        raw.recipient_address?.city ?? null,
      buyerState:       raw.recipient_address?.state ?? null,
      packId:           null, // Shopee não tem conceito de pack
      items,
      payments,
      shipment,
    };
  }
}