import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";

import authRouter from "./routes/auth";
import dashboardRouter from "./routes/dashboard";
import ordersRouter from "./routes/orders";
import shipmentsRouter from "./routes/shipments";
import costsRouter from "./routes/costs";
import mlRouter from "./routes/ml";
import employeesRouter from "./routes/employees";
import settingsRouter from "./routes/settings";
import subscriptionRouter from "./routes/subscription";
import exportRouter from "./routes/export";
import adminRouter from "./routes/admin";
import { runAlertJob } from "./jobs/alerts";
import { runTokenRefreshJob } from "./lib/ml";// imports novos (adicionar junto com os outros imports)
import shopeeRouter from "./routes/shopee";
import { MercadoLivreAdapter } from "./sync/adapters/MercadoLivreAdapter";
import { ShopeeAdapter } from "./sync/adapters/ShopeeAdapter";
import { syncEngine } from "./sync/SyncEngine";
import { runTier1Job, runTier2Job } from "./jobs/syncOrchestrator";
import channelsRouter from "./routes/channels";
import prisma from "./lib/prisma";



const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  })
);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use("/auth", authRouter);
app.use("/dashboard", dashboardRouter);
app.use("/orders", ordersRouter);
app.use("/profit", ordersRouter);           // /profit/orders
app.use("/shipments", shipmentsRouter);
app.use("/costs", costsRouter);
app.use("/ml", mlRouter);
app.use("/employees", employeesRouter);
app.use("/settings", settingsRouter);
app.use("/subscription", subscriptionRouter);
app.use("/export", exportRouter);
app.use("/admin", adminRouter);
app.use("/shopee", shopeeRouter);
app.use("/channels", channelsRouter);


// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Error]", err?.message ?? err);
  res.status(err.status ?? 500).json({ message: err.message ?? "Erro interno" });
});
syncEngine.registerAdapter(new MercadoLivreAdapter());
syncEngine.registerAdapter(new ShopeeAdapter());

// ─── RETOMA BACKFILLS PENDENTES NO BOOT ───────────────────────────────────────
async function resumePendingBackfills(): Promise<void> {
  try {
    const pending = await prisma.channelAccount.findMany({
      where: { initialSyncDone: false },
    });

    if (pending.length === 0) return;

    console.log(`[Boot] ${pending.length} conta(s) com backfill pendente — retomando...`);
    for (const account of pending) {
      triggerBackfillAsync(account.id);
    }
  } catch (err: any) {
    console.error("[Boot] Erro ao verificar backfills pendentes:", err?.message);
  }
}
// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || "development"}`);
  console.log(`   CORS allowed: ${allowedOrigins.join(", ")}`);
  
  // Retoma backfills que foram interrompidos por deploys
  resumePendingBackfills();
});

// ─── SYNC CRONS (production only) ────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  // Alertas — a cada hora
  setInterval(runAlertJob, 60 * 60 * 1000);
  setTimeout(runAlertJob, 5000);

  // Refresh de tokens ML antigos (tabela Token) — a cada 5h
  setInterval(runTokenRefreshJob, 5 * 60 * 60 * 1000);
  setTimeout(runTokenRefreshJob, 10000);

  // Tier 1 — descoberta incremental — a cada 15 min
  setInterval(runTier1Job, 15 * 60 * 1000);
  setTimeout(runTier1Job, 20000); // primeira execução 20s após o boot

  // Tier 2 — recheck de assentamento — a cada 5 min
  setInterval(runTier2Job, 5 * 60 * 1000);
  setTimeout(runTier2Job, 30000); // primeira execução 30s após o boot
}

export default app;
