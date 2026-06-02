import prisma from "../lib/prisma";

async function createAlertIfNotExists(data: {
  type: string; severity: string; clientId: number;
  tokenId?: number; description: string; metadata?: string;
}) {
  const existing = await prisma.adminAlert.findFirst({
    where: { type: data.type, clientId: data.clientId, status: "open", tokenId: data.tokenId ?? null },
  });
  if (!existing) {
    await prisma.adminAlert.create({ data });
  }
}

export async function runAlertJob() {
  console.log("[AlertJob] Running at", new Date().toISOString());

  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const past48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const past24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Tokens expiring in 7 days
  const expiringSoon = await prisma.token.findMany({
    where: { expiresAt: { gte: now, lte: in7Days } },
    include: { user: true },
  });
  for (const t of expiringSoon) {
    await createAlertIfNotExists({
      type: "token_expiring", severity: "warning", clientId: t.userId, tokenId: t.id,
      description: `Token da conta '${t.apelido ?? t.mlNickname ?? `#${t.id}`}' expira em menos de 7 dias`,
    });
  }

  // 2. Tokens expired 48h+
  const expiredOld = await prisma.token.findMany({
    where: { expiresAt: { lt: past48h } },
    include: { user: true },
  });
  for (const t of expiredOld) {
    await createAlertIfNotExists({
      type: "token_expired", severity: "critical", clientId: t.userId, tokenId: t.id,
      description: `Token da conta '${t.apelido ?? t.mlNickname ?? `#${t.id}`}' expirado há mais de 48h`,
    });
  }

  // 3. Clients without sync 24h+
  const noSync = await prisma.user.findMany({
    where: {
      role: "lider", active: true,
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: past24h } }],
    },
  });
  for (const u of noSync) {
    await createAlertIfNotExists({
      type: "no_sync", severity: "warning", clientId: u.id,
      description: `Cliente sem sincronização há mais de 24h`,
    });
  }

  // 4. Past due subscriptions 7d+
  const pastDue7d = await prisma.subscription.findMany({
    where: { status: "past_due", updatedAt: { lt: new Date(now.getTime() - 7 * 86400000) } },
  });
  for (const s of pastDue7d) {
    await createAlertIfNotExists({
      type: "past_due", severity: "critical", clientId: s.userId,
      description: `Assinatura inadimplente há 7+ dias`,
    });
  }

  // 5. Consecutive sync failures (3+)
  const users = await prisma.user.findMany({ where: { role: "lider", active: true } });
  for (const u of users) {
    const recentSyncs = await prisma.syncLog.findMany({
      where: { userId: u.id },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    if (recentSyncs.length >= 3 && recentSyncs.every((s) => s.status === "failed")) {
      await createAlertIfNotExists({
        type: "sync_consecutive_fail", severity: "critical", clientId: u.id,
        description: `Sync falhando consecutivamente nas últimas 3 tentativas`,
      });
    }
  }

  console.log("[AlertJob] Done");
}
