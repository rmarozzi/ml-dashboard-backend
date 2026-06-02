import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import prisma from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { requireAuth } from "../middlewares/auth";
import { buildOAuthUrl, exchangeCode } from "../lib/ml";
import axios from "axios";

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
  // Invalidate all other sessions
  await prisma.session.deleteMany({
    where: { userId: req.user.id, token: { not: req.sessionToken } },
  });
  return res.json({ ok: true });
});

// POST /auth/register (bootstrap - protected by ADMIN_SECRET)
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

// GET /auth/ml-url
router.get("/ml-url", requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({
    userId: req.user.id,
    frontendUrl: process.env.FRONTEND_URL,
  })).toString("base64");
  const url = buildOAuthUrl(state);
  return res.json({ url });
});

// GET /auth/callback (ML OAuth callback)
router.get("/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };
  if (!code || !state) return res.status(400).json({ message: "Parâmetros inválidos" });

  let decoded: any;
  try {
    decoded = JSON.parse(Buffer.from(state, "base64").toString());
  } catch {
    return res.status(400).json({ message: "State inválido" });
  }

  const tokens = await exchangeCode(code);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch ML user info
  let mlUserId: string | null = null;
  let mlNickname: string | null = null;
  try {
    const mlRes = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    mlUserId = String(mlRes.data.id);
    mlNickname = mlRes.data.nickname;
  } catch {}

  await prisma.token.create({
    data: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      userId: decoded.userId,
      mlUserId,
      mlNickname,
    },
  });

  const frontendUrl = decoded.frontendUrl || process.env.FRONTEND_URL || "http://localhost:3000";
  return res.redirect(`${frontendUrl}/dashboard/profile?ml=connected`);
});

export default router;
