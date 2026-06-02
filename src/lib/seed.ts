import bcrypt from "bcryptjs";
import prisma from "./prisma";

async function main() {
  console.log("🌱 Seeding database...");

  // Create plans
  const plans = [
    { nome: "Bronze", slug: "bronze", preco: 97, maxMlAccounts: 1, maxFuncionarios: 0, maxSyncOrders: 50, autoSync: false, granularPermissions: false, mlAccessControl: false, canExport: false, canViewAnalytics: false, canViewProfit: false, canManageCosts: false, canDebugSync: false, supportSla: false },
    { nome: "Prata", slug: "prata", preco: 197, maxMlAccounts: 2, maxFuncionarios: 1, maxSyncOrders: 50, autoSync: false, granularPermissions: false, mlAccessControl: false, canExport: false, canViewAnalytics: false, canViewProfit: true, canManageCosts: true, canDebugSync: false, supportSla: false },
    { nome: "Ouro", slug: "ouro", preco: 397, maxMlAccounts: 5, maxFuncionarios: 3, maxSyncOrders: 200, autoSync: true, granularPermissions: true, mlAccessControl: true, canExport: false, canViewAnalytics: true, canViewProfit: true, canManageCosts: true, canDebugSync: false, supportSla: false },
    { nome: "Premium", slug: "premium", preco: 897, maxMlAccounts: -1, maxFuncionarios: -1, maxSyncOrders: 99999, autoSync: true, granularPermissions: true, mlAccessControl: true, canExport: true, canViewAnalytics: true, canViewProfit: true, canManageCosts: true, canDebugSync: true, supportSla: true },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({ where: { slug: plan.slug }, create: plan, update: plan });
    console.log(`  ✅ Plan: ${plan.nome}`);
  }

  // Create admin
  const adminEmail = process.env.ADMIN_EMAIL || "admin@mldash.com";
  const adminPw = process.env.ADMIN_PASSWORD || "admin123";
  const hash = await bcrypt.hash(adminPw, 12);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, password: hash, name: "Administrador", role: "admin" },
    update: {},
  });
  console.log(`  ✅ Admin: ${adminEmail}`);

  // Create demo lider with Ouro plan
  const ouPlan = await prisma.plan.findUnique({ where: { slug: "ouro" } });
  const liderEmail = "demo@loja.com";
  const liderPw = "demo1234";
  const liderHash = await bcrypt.hash(liderPw, 12);
  const lider = await prisma.user.upsert({
    where: { email: liderEmail },
    create: {
      email: liderEmail, password: liderHash, name: "João Demo", role: "lider",
      subscription: {
        create: {
          planId: ouPlan!.id, status: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        },
      },
    },
    update: {},
  });
  console.log(`  ✅ Demo Lider: ${liderEmail} / ${liderPw}`);

  console.log("\n✅ Seed completed!");
  console.log(`\nAdmin: ${adminEmail} / ${adminPw}`);
  console.log(`Demo:  ${liderEmail} / ${liderPw}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
