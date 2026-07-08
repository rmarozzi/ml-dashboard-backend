import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

function buildDatabaseUrl(): string {
  const base = process.env.DATABASE_URL!;
  try {
    const url = new URL(base);
    if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "5");
    if (!url.searchParams.has("pool_timeout"))     url.searchParams.set("pool_timeout", "15");
    if (!url.searchParams.has("connect_timeout"))  url.searchParams.set("connect_timeout", "15");
    return url.toString();
  } catch {
    return base;
  }
}

const prisma =
  global.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: { db: { url: buildDatabaseUrl() } },
  });

if (process.env.NODE_ENV !== "production") global.prisma = prisma;

export default prisma;