import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import axios from "axios";
import prisma from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { requireAuth } from "../middlewares/auth";
import { buildOAuthUrl, exchangeCode } from "../lib/ml";
import { encrypt } from "../lib/crypto";
import { triggerBackfillAsync } from "../jobs/syncOrchestrator";

const router = Router();

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "E-mail e senha obrigatórios" });

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { subscription: { include: { plan: true } } },
  });

  if (!user || !user.active) return res.status(401).json({ message: "E-mail ou senha incorretos" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ message: "E-mail ou senha incorretos" });

  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      token: sessionToken,
      userId: user.id,
      expiresAt,
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip ?? null,
    },
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  res.cookie("session_token", sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  const { password: _, ...safeUser } = user;
  return res.json({ user: safeUser });
});

// POST /auth/logout
router.post("/logout", requireAuth, async (req, res) => {
  await prisma.session.deleteMany({ where: { token: req.sessionToken } });
  res.clearCookie("session_token");
  return res.json({ ok: true });
});

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
  const { password: _, ...safeUser } = req.user;
  return res.json({ user: safeUser });
});

// POST /auth/change-password
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: "Campos obrigatórios" });
  if (newPassword.length < 6) return res.status(400).json({ message: "Mínimo 6 caracteres" });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const valid = await bcrypt.compare(currentPassword, user!.password);
  if (!valid) return res.status(400).json({ message: "Senha atual incorreta" });

  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: req.user.id }, data: { password: hash } });
  await prisma.session.deleteMany({
    where: { userId: req.user.id, token: { not: req.sessionToken } },
  });
  return res.json({ ok: true });
});

// POST /auth/register (bootstrap — protegido por ADMIN_SECRET)
router.post("/register", async (req, res) => {
  const { secret, email, password, name } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ message: "Forbidden" });

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ message: "E-mail já cadastrado" });

  const hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), password: hash, name, role: "admin" },
  });
  const { password: _, ...safeUser } = user;
  return res.status(201).json({ user: safeUser });
});

// GET /auth/ml-url — gera URL de autorização do ML com state assinado
router.get("/ml-url", requireAuth, (req, res) => {
  // State assinado com HMAC — evita account hijacking
  const payload = `${req.user.id}:${Date.now()}`;
  const sig = crypto
    .createHmac("sha256", process.env.TOKEN_ENCRYPTION_KEY!)
    .update(payload)
    .digest("hex");
  const state = Buffer.from(`${payload}:${sig}`).toString("base64url");
  const url = buildOAuthUrl(state);
  return res.json({ url });
});

// GET /auth/callback — callback OAuth do Mercado Livre
router.get("/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };
  if (!code || !state) return res.status(400).json({ message: "Parâmetros inválidos" });

  // Valida state assinado
  let userId: number;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) throw new Error("formato inválido");

    const [userIdStr, tsStr, sig] = parts;
    const payload = `${userIdStr}:${tsStr}`;
    const expected = crypto
      .createHmac("sha256", process.env.TOKEN_ENCRYPTION_KEY!)
      .update(payload)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error("assinatura inválida");
    }

    // State válido por 10 minutos
    if (Date.now() - parseInt(tsStr) > 10 * 60 * 1000) {
      throw new Error("state expirado");
    }

    userId = parseInt(userIdStr);
  } catch (err: any) {
    return res.status(400).json({ message: `State inválido: ${err?.message}` });
  }

  // Troca code por tokens
  const tokens = await exchangeCode(code);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Busca informações do seller no ML
  let mlUserId: string | null = null;
  let mlNickname: string | null = null;
  try {
    const mlRes = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    mlUserId = String(mlRes.data.id);
    mlNickname = mlRes.data.nickname;
  } catch {}

  if (!mlUserId) {
    return res.status(502).json({ message: "Não foi possível obter dados do seller no ML." });
  }

  // Cria ou atualiza ChannelAccount (upsert — reconexão não duplica)
  const account = await prisma.channelAccount.upsert({
    where: {
      userId_channelType_externalAccountId: {
        userId,
        channelType:       "MERCADO_LIVRE",
        externalAccountId: mlUserId,
      },
    },
    create: {
      userId,
      channelType:       "MERCADO_LIVRE",
      externalAccountId: mlUserId,
      accessTokenEnc:    encrypt(tokens.access_token),
      refreshTokenEnc:   encrypt(tokens.refresh_token),
      tokenExpiresAt:    expiresAt,
      externalNickname:  mlNickname,
      apelido:           mlNickname,
    },
    update: {
      accessTokenEnc:   encrypt(tokens.access_token),
      refreshTokenEnc:  encrypt(tokens.refresh_token),
      tokenExpiresAt:   expiresAt,
      externalNickname: mlNickname ?? undefined,
    },
  });

  // Dispara backfill em background se ainda não foi feito
  if (!account.initialSyncDone) {
    triggerBackfillAsync(account.id);
  }

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  return res.redirect(`${frontendUrl}/dashboard/profile?ml=connected`);
});

export default router;