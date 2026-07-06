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


// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Error]", err?.message ?? err);
  res.status(err.status ?? 500).json({ message: err.message ?? "Erro interno" });
});
syncEngine.registerAdapter(new MercadoLivreAdapter());
syncEngine.registerAdapter(new ShopeeAdapter());
// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || "development"}`);
  console.log(`   CORS allowed: ${allowedOrigins.join(", ")}`);
});

// ─── ALERT CRON (every hour) ──────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  setInterval(runAlertJob, 60 * 60 * 1000);
  setTimeout(runAlertJob, 5000);

  setInterval(runTokenRefreshJob, 5 * 60 * 60 * 1000);
  setTimeout(runTokenRefreshJob, 10000);

}

export default app;
