import prisma from "../lib/prisma";
import { syncOrdersForUser } from "../routes/sync";

export async function runAutoSyncJob() {
  console.log("[AutoSyncJob] Verificando clientes com sync automático ativo...");

  // Busca líderes ativos, com plano Ouro+ (que suporta autoSync) e settings.autoSync = true
  const liders = await prisma.user.findMany({
    where: {
      role: "lider",
      active: true,
      subscription: {
        status: { in: ["active", "trial"] },
        plan: { autoSync: true },
      },
    },
    select: { id: true, settings: true, lastSyncAt: true },
  });

  const eligible = liders.filter((u) => {
    if (!u.settings) return false;
    try {
      const s = JSON.parse(u.settings);
      return s.autoSync === true;
    } catch {
      return false;
    }
  });

  console.log(`[AutoSyncJob] ${eligible.length} cliente(s) com sync automático ativo`);

  for (const user of eligible) {
    // Evita sync duplicado se já rodou nos últimos 50 minutos
    if (user.lastSyncAt) {
      const minsSinceLastSync = (Date.now() - new Date(user.lastSyncAt).getTime()) / 60000;
      if (minsSinceLastSync < 50) continue;
    }

    try {
      await syncOrdersForUser(user.id);
      console.log(`[AutoSyncJob] Sync concluído para usuário #${user.id}`);
    } catch (err: any) {
      console.error(`[AutoSyncJob] Falha ao sincronizar usuário #${user.id}:`, err?.message);
    }
  }

  console.log("[AutoSyncJob] Concluído");
}