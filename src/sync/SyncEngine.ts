// src/sync/SyncEngine.ts
//
// Motor central de sincronização multi-canal.
// Não conhece detalhes de nenhuma plataforma — só orquestra os adapters
// e persiste os resultados via SyncExecutionLog.

import prisma from "../lib/prisma";
import { ChannelAccount, SyncStatus } from "@prisma/client";
import {
  ChannelSyncAdapter,
  NormalizedOrder,
  SyncTierResult,
} from "./types";

export class SyncEngine {
  private adapters = new Map<string, ChannelSyncAdapter>();
  private backfillInProgress = new Set<string>();

  // ─── REGISTRO DE ADAPTERS ───────────────────────────────────────────────────

  registerAdapter(adapter: ChannelSyncAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
    console.log(`[SyncEngine] Adapter registrado: ${adapter.channelType}`);
  }

  private getAdapter(account: ChannelAccount): ChannelSyncAdapter {
    const adapter = this.adapters.get(account.channelType);
    if (!adapter) {
      throw new Error(
        `[SyncEngine] Nenhum adapter registrado para canal: ${account.channelType}`
      );
    }
    return adapter;
  }

  // ─── TIER 0 — BACKFILL HISTÓRICO ───────────────────────────────────────────

  async runBackfill(account: ChannelAccount, since?: Date): Promise<void> {
    if (this.backfillInProgress.has(account.id)) {
      console.log(`[SyncEngine][Tier0] Backfill já em andamento para conta ${account.id} — ignorando.`);
      return;
    }
    this.backfillInProgress.add(account.id);

    const adapter = this.getAdapter(account);
    const logId = await this.startLog(account.id, 0);

    let ordersFound = 0;
    let ordersUpserted = 0;

    try {
      console.log(
        `[SyncEngine][Tier0] Iniciando backfill: ${account.channelType} / conta ${account.id}`
      );

      for await (const batch of adapter.backfillHistorical(account, since)) {
        ordersFound += batch.length;
        const upserted = await this.persistBatch(batch);
        ordersUpserted += upserted;
        console.log(
          `[SyncEngine][Tier0] Lote processado: ${batch.length} encontrados, ${upserted} persistidos`
        );
      }

      await this.finishLog(logId, SyncStatus.SUCCESS, { ordersFound, ordersUpserted });

      await prisma.channelAccount.update({
        where: { id: account.id },
        data: { initialSyncDone: true, lastSyncAt: new Date() },
      });

      console.log(
        `[SyncEngine][Tier0] Backfill concluído: ${ordersUpserted} pedidos persistidos`
      );
    } catch (err: any) {
      console.error(`[SyncEngine][Tier0] Erro:`, err?.message);
      await this.finishLog(logId, SyncStatus.FAILED, {
        ordersFound,
        ordersUpserted,
        errorDetail: err?.message,
      });
      throw err;
    } finally {
      this.backfillInProgress.delete(account.id);
    }
  }

  // ─── TIER 1 — DESCOBERTA INCREMENTAL ───────────────────────────────────────

  async runIncrementalSync(account: ChannelAccount): Promise<void> {
    if (!account.initialSyncDone) {
      console.log(
        `[SyncEngine][Tier1] Backfill pendente para conta ${account.id} — pulando Tier1`
      );
      return;
    }

    const adapter = this.getAdapter(account);
    const since = account.lastSyncAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const until = new Date();
    const logId = await this.startLog(account.id, 1, since, until);

    let ordersFound = 0;
    let ordersUpserted = 0;

    try {
      console.log(
        `[SyncEngine][Tier1] ${account.channelType} / conta ${account.id} — janela: ${since.toISOString()} → ${until.toISOString()}`
      );

      for await (const batch of adapter.discoverUpdatedOrders(account, since, until)) {
        ordersFound += batch.length;
        const upserted = await this.persistBatch(batch);
        ordersUpserted += upserted;
      }

      await this.finishLog(logId, SyncStatus.SUCCESS, { ordersFound, ordersUpserted });

      await prisma.channelAccount.update({
        where: { id: account.id },
        data: { lastSyncAt: until },
      });

      console.log(
        `[SyncEngine][Tier1] Concluído: ${ordersUpserted} pedidos persistidos`
      );
    } catch (err: any) {
      console.error(`[SyncEngine][Tier1] Erro:`, err?.message);
      await this.finishLog(logId, SyncStatus.FAILED, {
        ordersFound,
        ordersUpserted,
        errorDetail: err?.message,
      });
    }
  }

  // ─── TIER 2 — RECHECK DE PEDIDOS NÃO ASSENTADOS ────────────────────────────

  async runSettlementRecheck(account: ChannelAccount): Promise<void> {
    const adapter = this.getAdapter(account);

    const window30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const unsettledOrders = await prisma.order.findMany({
      where: {
        channelAccountId: account.id,
        dateCreated: { gte: window30d },
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

    if (unsettledOrders.length === 0) return;

    const externalIds = unsettledOrders.map((o) => o.externalOrderId);
    const logId = await this.startLog(account.id, 2);

    try {
      console.log(
        `[SyncEngine][Tier2] ${account.channelType} / conta ${account.id} — ${externalIds.length} pedidos para recheck`
      );

      const orders = await adapter.recheckOrders(account, externalIds);
      const upserted = await this.persistBatch(orders);

      await this.finishLog(logId, SyncStatus.SUCCESS, {
        ordersFound: orders.length,
        ordersUpserted: upserted,
      });

      console.log(`[SyncEngine][Tier2] Concluído: ${upserted} pedidos atualizados`);
    } catch (err: any) {
      console.error(`[SyncEngine][Tier2] Erro:`, err?.message);
      await this.finishLog(logId, SyncStatus.FAILED, {
        ordersFound: 0,
        ordersUpserted: 0,
        errorDetail: err?.message,
      });
    }
  }

  // ─── PERSISTÊNCIA ───────────────────────────────────────────────────────────

  private async persistBatch(orders: NormalizedOrder[]): Promise<number> {
    let upserted = 0;

    for (const order of orders) {
      try {
        await prisma.$transaction(async (tx) => {
          const saved = await tx.order.upsert({
            where: { externalOrderId: order.externalOrderId },
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
              status:           order.status,
              dateLastUpdated:  order.dateLastUpdated,
              netReceived:      order.netReceived,
              taxesAmount:      order.taxesAmount,
              shippingCost:     order.shippingCost,
              shippingDiscount: order.shippingDiscount,
              buyerName:        order.buyerName ?? undefined,
              buyerCity:        order.buyerCity,
              buyerState:       order.buyerState,
            },
          });

          for (const payment of order.payments) {
            if (!payment.externalPaymentId) continue;
            await tx.payment.upsert({
              where: { externalPaymentId: payment.externalPaymentId },
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
                status:           payment.status,
                totalPaidAmount:  payment.totalPaidAmount,
                moneyReleaseDate: payment.moneyReleaseDate,
              },
            });
          }

          if (order.items.length > 0) {
            const existing = await tx.item.count({ where: { orderId: saved.id } });
            if (existing === 0) {
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

          if (order.shipment) {
            await tx.shipment.upsert({
              where: { orderId: saved.id },
              create: {
                orderId:            saved.id,
                externalShipmentId: order.shipment.externalShipmentId,
                status:             order.shipment.status,
                trackingNumber:     order.shipment.trackingNumber,
                cost:               order.shipment.cost,
              },
              update: {
                status:         order.shipment.status,
                trackingNumber: order.shipment.trackingNumber,
                cost:           order.shipment.cost,
              },
            });
          }
        });

        upserted++;
      } catch (err: any) {
        console.error(
          `[SyncEngine] Erro ao persistir pedido ${order.externalOrderId}:`,
          err?.message
        );
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
      data: {
        channelAccountId,
        tier,
        windowStart,
        windowEnd,
        status: SyncStatus.RUNNING,
      },
    });
    return log.id;
  }

  private async finishLog(
    logId: string,
    status: SyncStatus,
    result: SyncTierResult
  ): Promise<void> {
    await prisma.syncExecutionLog.update({
      where: { id: logId },
      data: {
        status,
        finishedAt:     new Date(),
        ordersFound:    result.ordersFound,
        ordersUpserted: result.ordersUpserted,
        errorDetail:    result.errorDetail,
      },
    });
  }
}

export const syncEngine = new SyncEngine();