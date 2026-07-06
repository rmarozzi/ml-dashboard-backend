// src/jobs/syncOrchestrator.ts
//
// Orquestração automática do SyncEngine.
// - Tier 1: roda a cada 15 minutos para todas as contas ativas
// - Tier 2: roda a cada 5 minutos para recheck de pedidos não assentados
// - Tier 0: disparado pontualmente na conexão de uma nova conta (não é cron)
//
// Cada conta processa de forma isolada — falha em uma não derruba as demais.

import prisma from "../lib/prisma";
import { syncEngine } from "../sync/SyncEngine";

// ─── TIER 0 — BACKFILL (disparado na conexão de nova conta) ──────────────────
// Chamado diretamente pelas rotas de OAuth (ML e Shopee) após criação da conta.
// Roda em background sem bloquear a resposta HTTP.

const backfillQueued = new Set<string>();

export function triggerBackfillAsync(channelAccountId: string): void {
  if (backfillQueued.has(channelAccountId)) {
    console.log(`[Orchestrator] Backfill já enfileirado para conta ${channelAccountId} — ignorando.`);
    return;
  }
  backfillQueued.add(channelAccountId);

  prisma.channelAccount
    .findUnique({ where: { id: channelAccountId } })
    .then(async (account) => {
      if (!account) return;
      console.log(`[Tier0] Iniciando backfill para conta ${channelAccountId}...`);
      await syncEngine.runBackfill(account);
    })
    .catch((err) => {
      console.error(`[Tier0] Erro no backfill da conta ${channelAccountId}:`, err?.message);
    })
    .finally(() => {
      backfillQueued.delete(channelAccountId);
    });
}

// ─── CONCORRÊNCIA CONTROLADA ──────────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item).catch((err) =>
        console.error("[Orchestrator] Erro isolado:", err?.message)
      );
    }
  });
  await Promise.all(workers);
}

// ─── TIER 1 — DESCOBERTA INCREMENTAL (a cada 15 min) ─────────────────────────

export async function runTier1Job(): Promise<void> {
  console.log("[Tier1] Iniciando descoberta incremental...");

  const accounts = await prisma.channelAccount.findMany({
    where: { initialSyncDone: true },
  });

  if (accounts.length === 0) {
    console.log("[Tier1] Nenhuma conta com backfill concluído. Pulando.");
    return;
  }

  console.log(`[Tier1] ${accounts.length} conta(s) para processar.`);

  await runWithConcurrency(accounts, 3, async (account) => {
    try {
      await syncEngine.runIncrementalSync(account);
    } catch (err: any) {
      console.error(`[Tier1] Falha na conta ${account.id}:`, err?.message);
    }
  });

  console.log("[Tier1] Concluído.");
}

// ─── TIER 2 — RECHECK DE ASSENTAMENTO (a cada 5 min) ─────────────────────────

export async function runTier2Job(): Promise<void> {
  console.log("[Tier2] Iniciando recheck de assentamento...");

  const accounts = await prisma.channelAccount.findMany({
    where: { initialSyncDone: true },
  });

  if (accounts.length === 0) return;

  await runWithConcurrency(accounts, 3, async (account) => {
    try {
      await syncEngine.runSettlementRecheck(account);
    } catch (err: any) {
      console.error(`[Tier2] Falha na conta ${account.id}:`, err?.message);
    }
  });

  console.log("[Tier2] Concluído.");
}