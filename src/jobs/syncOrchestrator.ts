import prisma from "../lib/prisma";
import { syncEngine } from "../sync/SyncEngine";

const backfillQueued = new Set<string>();

// ─── TIER 0 ──────────────────────────────────────────────────────────────────

export function triggerBackfillAsync(channelAccountId: string): void {
  if (backfillQueued.has(channelAccountId)) {
    console.log(`[Orchestrator] Backfill já enfileirado para ${channelAccountId} — ignorando.`);
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
      await fn(item).catch((err) => console.error("[Orchestrator] Erro isolado:", err?.message));
    }
  });
  await Promise.all(workers);
}

// ─── TIER 1 — INCREMENTAL ─────────────────────────────────────────────────────

export async function runTier1Job(): Promise<void> {
  const accounts = await prisma.channelAccount.findMany({
    where: { initialSyncDone: true },
  });

  if (accounts.length === 0) return;

  console.log(`[Tier1] ${accounts.length} conta(s) para processar.`);

  await runWithConcurrency(accounts, 3, async (account) => {
    await syncEngine.runIncrementalSync(account);
  });

  console.log("[Tier1] Concluído.");
}

// ─── TIER 2 — RECHECK ─────────────────────────────────────────────────────────

export async function runTier2Job(): Promise<void> {
  const accounts = await prisma.channelAccount.findMany({
    where: { initialSyncDone: true },
  });

  if (accounts.length === 0) return;

  await runWithConcurrency(accounts, 3, async (account) => {
    await syncEngine.runSettlementRecheck(account);
  });

  console.log("[Tier2] Concluído.");
}