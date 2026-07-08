import prisma from "../lib/prisma";
import { ChannelAccount, SyncStatus } from "@prisma/client";
import { ChannelSyncAdapter, NormalizedOrder, SyncTierResult } from "./types";

export class SyncEngine {
  private adapters           = new Map<string, ChannelSyncAdapter>();
  private backfillInProgress = new Set<string>();

  registerAdapter(adapter: ChannelSyncAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
    console.log(`[SyncEngine] Adapter registrado: ${adapter.channelType}`);
  }

  getAdapter(channelType: string): ChannelSyncAdapter {
    const adapter = this.adapters.get(channelType);
    if (!adapter) throw new Error(`[SyncEngine] Nenhum adapter para: ${channelType}`);
    return adapter;
  }

  private getAdapterForAccount(account: ChannelAccount): ChannelSyncAdapter {
    return this.getAdapter(account.channelType);
  }

  // ─── TIER 0 — BACKFILL ──────────────────────────────────────────────────────

  async runBackfill(account: ChannelAccount, since?: Date): Promise<void> {
    if (this.backfillInProgress.has(account.id)) {
      console.log(`[SyncEngine][Tier0] Backfill já em andamento para ${account.id} — ignorando.`);
      return;
    }
    this.backfillInProgress.add(account.id);

    const adapter = this.getAdapterForAccount(account);
    const logId   = await this.startLog(account.id, 0);
    let ordersFound = 0, ordersUpserted = 0;

    try {
      console.log(`[SyncEngine][Tier0] Iniciando backfill: ${account.channelType} / ${account.id}`);

      for await (const batch of adapter.backfillHistorical(account, since)) {
        ordersFound    += batch.length;
        ordersUpserted += await this.persistBatch(batch);
        console.log(`[SyncEngine][Tier0] Lote: ${batch.length} encontrados, ${ordersUpserted} persistidos total`);
      }

      // ✅ CRÍTICO: marca como concluído ANTES do finishLog
      // Se o finishLog falhar (log apagado externamente), o initialSyncDone já foi gravado
      await prisma.channelAccount.update({
        where: { id: account.id },
        data:  { initialSyncDone: true, lastSyncAt: new Date() },
      });

      await this.finishLog(logId, SyncStatus.SUCCESS, { ordersFound, ordersUpserted });
      console.log(`[SyncEngine][Tier0] Backfill concluído: ${ordersUpserted} pedidos persistidos`);

    } catch (err: any) {
      console.error(`[SyncEngine][Tier0] Erro:`, err?.message);
      await this.finishLog(logId, SyncStatus.FAILED, { ordersFound, ordersUpserted, errorDetail: err?.message });
      throw err;
    } finally {
      this.backfillInProgress.delete(account.id);
    }
  }

  // ─── TIER 1 — INCREMENTAL ───────────────────────────────────────────────────

  async runIncrementalSync(account: ChannelAccount): Promise<void> {
    if (!account.initialSyncDone) return;

    const adapter = this.getAdapterForAccount(account);
    const since   = account.lastSyncAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const until   = new Date();
    const logId   = await this.startLog(account.id, 1, since, until);
    let ordersFound = 0, ordersUpserted = 0;

    try {
      console.log(`[SyncEngine][Tier1] ${account.channelType} / ${account.id} — ${since.toISOString()} → ${until.toISOString()}`);

      for await (const batch of adapter.discoverUpdatedOrders(account, since, until)) {
        ordersFound    += batch.length;
        ordersUpserted += await this.persistBatch(batch);
      }

      await prisma.channelAccount.update({ where: { id: account.id }, data: { lastSyncAt: until } });
      await this.finishLog(logId, SyncStatus.SUCCESS, { ordersFound, ordersUpserted });

      if (ordersFound > 0) {
        console.log(`[SyncEngine][Tier1] ${ordersUpserted} pedidos atualizados`);
      }
    } catch (err: any) {
      const status = err?.response?.status;
      // 400/403 no Tier1 é tolerável — webhooks cobrem atualizações em tempo real
      if (status === 400 || status === 403) {
        console.warn(`[SyncEngine][Tier1] ML retornou ${status} — ignorando (webhooks ativos)`);
        await this.finishLog(logId, SyncStatus.PARTIAL, { ordersFound, ordersUpserted, errorDetail: `HTTP ${status}` });
        return;
      }
      console.error(`[SyncEngine][Tier1] Erro:`, err?.message);
      await this.finishLog(logId, SyncStatus.FAILED, { ordersFound, ordersUpserted, errorDetail: err?.message });
    }
  }

  // ─── TIER 2 — RECHECK DE ASSENTAMENTO ──────────────────────────────────────

  async runSettlementRecheck(account: ChannelAccount): Promise<void> {
    if (!account.initialSyncDone) return;

    const adapter   = this.getAdapterForAccount(account);
    const window30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now       = new Date();

    const unsettled = await prisma.order.findMany({
      where: {
        channelAccountId: account.id,
        dateCreated:      { gte: window30d },
        payments: {
          some: {
            OR: [
              { moneyReleaseDate: null },
              { moneyReleaseDate: { gt: now } },
            ],
          },
        },
      },
      select: { externalOrderId: true },
    });

    if (unsettled.length === 0) return;

    const logId = await this.startLog(account.id, 2);
    let ordersFound = 0, ordersUpserted = 0;

    try {
      console.log(`[SyncEngine][Tier2] ${account.channelType} / ${account.id} — ${unsettled.length} pedidos para recheck`);

      const orders   = await adapter.recheckOrders(account, unsettled.map((o) => o.externalOrderId));
      ordersFound    = orders.length;
      ordersUpserted = await this.persistBatch(orders);

      await this.finishLog(logId, SyncStatus.SUCCESS, { ordersFound, ordersUpserted });
      console.log(`[SyncEngine][Tier2] ${ordersUpserted} pedidos atualizados`);
    } catch (err: any) {
      console.error(`[SyncEngine][Tier2] Erro:`, err?.message);
      await this.finishLog(logId, SyncStatus.FAILED, { ordersFound, ordersUpserted, errorDetail: err?.message });
    }
  }

  // ─── WEBHOOK — ATUALIZAÇÃO EM TEMPO REAL ────────────────────────────────────

  async processWebhook(account: ChannelAccount, payload: any): Promise<void> {
    const adapter = this.getAdapterForAccount(account);
    if (!adapter.handleWebhook) return;

    try {
      const order = await adapter.handleWebhook(account, payload);
      if (order) await this.persistBatch([order]);
    } catch (err: any) {
      console.error(`[SyncEngine][Webhook] Erro:`, err?.message);
    }
  }

  // ─── PERSISTÊNCIA ───────────────────────────────────────────────────────────

  async persistBatch(orders: NormalizedOrder[]): Promise<number> {
    let upserted = 0;

    for (const order of orders) {
      try {
        await prisma.$transaction(async (tx) => {

          const saved = await tx.order.upsert({
            where:  { externalOrderId: order.externalOrderId },
            create: {
              externalOrderId:  order.externalOrderId,
              channelAccountId: order.channelAccountId,
              userId:           order.userId,
              channelType:      order.channelType,
              status:           order.status,
              dateCreated:      order.dateCreated,
              dateLastUpdated:  order.dateLastUpdated,
              totalAmount:      order.totalAmount,
              netReceived:      order.netReceived,
              taxesAmount:      order.taxesAmount,
              shippingCost:     order.shippingCost,
              shippingDiscount: order.shippingDiscount,
              buyerName:        order.buyerName,
              buyerDocType:     order.buyerDocType,
              buyerDocNumber:   order.buyerDocNumber,
              buyerCity:        order.buyerCity,
              buyerState:       order.buyerState,
              packId:           order.packId,
            },
            update: {
              status:          order.status,
              dateLastUpdated: order.dateLastUpdated,
              // ✅ Nunca sobrescreve com null — preserva dados já salvos
              ...(order.netReceived      != null && { netReceived:      order.netReceived }),
              ...(order.taxesAmount      != null && { taxesAmount:      order.taxesAmount }),
              ...(order.shippingCost     != null && { shippingCost:     order.shippingCost }),
              ...(order.shippingDiscount != null && { shippingDiscount: order.shippingDiscount }),
              ...(order.buyerName        != null && { buyerName:        order.buyerName }),
              ...(order.buyerDocType     != null && { buyerDocType:     order.buyerDocType }),
              ...(order.buyerDocNumber   != null && { buyerDocNumber:   order.buyerDocNumber }),
              ...(order.buyerCity        != null && { buyerCity:        order.buyerCity }),
              ...(order.buyerState       != null && { buyerState:       order.buyerState }),
            },
          });

          // Pagamentos
          for (const payment of order.payments) {
            if (!payment.externalPaymentId) continue;
            await tx.payment.upsert({
              where:  { externalPaymentId: payment.externalPaymentId },
              create: {
                orderId:           saved.id,
                externalPaymentId: payment.externalPaymentId,
                status:            payment.status,
                totalPaidAmount:   payment.totalPaidAmount,
                taxesAmount:       payment.taxesAmount,
                operationType:     payment.operationType,
                paymentMethodId:   payment.paymentMethodId,
                moneyReleaseDate:  payment.moneyReleaseDate,
              },
              update: {
                status:          payment.status,
                totalPaidAmount: payment.totalPaidAmount,
                ...(payment.moneyReleaseDate  != null && { moneyReleaseDate:  payment.moneyReleaseDate }),
                ...(payment.netReceivedAmount != null && { netReceivedAmount: payment.netReceivedAmount }),
              },
            });
          }

          // Itens — imutáveis após a venda, só cria na primeira vez
          if (order.items.length > 0) {
            const exists = await tx.item.count({ where: { orderId: saved.id } });
            if (exists === 0) {
              await tx.item.createMany({
                data: order.items.map((i) => ({
                  orderId:        saved.id,
                  externalItemId: i.externalItemId,
                  title:          i.title,
                  quantity:       i.quantity,
                  unitPrice:      i.unitPrice,
                  sku:            i.sku,
                  saleFee:        i.saleFee,
                })),
              });
            }
          }

          // Envio
          if (order.shipment) {
            await tx.shipment.upsert({
              where:  { orderId: saved.id },
              create: {
                orderId:            saved.id,
                externalShipmentId: order.shipment.externalShipmentId,
                status:             order.shipment.status,
                trackingNumber:     order.shipment.trackingNumber,
                cost:               order.shipment.cost,
              },
              update: {
                status: order.shipment.status,
                ...(order.shipment.trackingNumber != null && { trackingNumber: order.shipment.trackingNumber }),
                ...(order.shipment.cost           != null && { cost:           order.shipment.cost }),
              },
            });
          }
        });

        upserted++;
      } catch (err: any) {
        console.error(`[SyncEngine] Erro ao persistir pedido ${order.externalOrderId}:`, err?.message);
      }
    }

    return upserted;
  }

  // ─── HELPERS DE LOG ─────────────────────────────────────────────────────────

  private async startLog(
    channelAccountId: string,
    tier: number,
    windowStart?: Date,
    windowEnd?: Date
  ): Promise<string> {
    const log = await prisma.syncExecutionLog.create({
      data: { channelAccountId, tier, windowStart, windowEnd, status: SyncStatus.RUNNING },
    });
    return log.id;
  }

  private async finishLog(logId: string, status: SyncStatus, result: SyncTierResult): Promise<void> {
    try {
      await prisma.syncExecutionLog.update({
        where: { id: logId },
        data:  {
          status,
          finishedAt:     new Date(),
          ordersFound:    result.ordersFound,
          ordersUpserted: result.ordersUpserted,
          errorDetail:    result.errorDetail,
        },
      });
    } catch (err: any) {
      // P2025 = record not found (log apagado externamente) — não é crítico
      if (err?.code === "P2025") {
        console.warn(`[SyncEngine] finishLog: log ${logId} não encontrado — ignorando`);
        return;
      }
      console.error(`[SyncEngine] finishLog erro:`, err?.message);
    }
  }
}

export const syncEngine = new SyncEngine();