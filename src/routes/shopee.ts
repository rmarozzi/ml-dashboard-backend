// src/routes/shopee.ts

import { Router } from "express";
import crypto from "crypto";
import axios from "axios";
import prisma from "../lib/prisma";
import { requireAuth } from "../middlewares/auth";
import { encrypt } from "../lib/crypto";
import { triggerBackfillAsync } from "../jobs/syncOrchestrator";

const router = Router();

// ✅ Usa SHOPEE_ENV em vez de NODE_ENV para controlar sandbox vs produção
const SHOPEE_BASE  = process.env.SHOPEE_ENV === "test"
  ? "https://partner.test-stable.shopeemobile.com"
  : "https://openplatform.shopee.com.br";

const PARTNER_ID   = parseInt(process.env.SHOPEE_PARTNER_ID!);
const PARTNER_KEY  = process.env.SHOPEE_PARTNER_KEY!;
const REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI!;
const STATE_SECRET = process.env.SHOPEE_STATE_SECRET ?? process.env.TOKEN_ENCRYPTION_KEY!;

// ─── ASSINATURA HMAC-SHA256 ───────────────────────────────────────────────────

function shopeeSign(path: string, timestamp: number, accessToken = "", shopId = ""): string {
  const base = `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

// ─── STATE ASSINADO ───────────────────────────────────────────────────────────

function createSignedState(userId: number): string {
  const payload = `${userId}:${Date.now()}`;
  const sig     = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function verifySignedState(state: string): { userId: number } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts   = decoded.split(":");
    if (parts.length !== 3) return null;

    const [userIdStr, tsStr, sig] = parts;
    const payload  = `${userIdStr}:${tsStr}`;
    const expected = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const ts = parseInt(tsStr);
    if (Date.now() - ts > 10 * 60 * 1000) return null;

    return { userId: parseInt(userIdStr) };
  } catch {
    return null;
  }
}

// ─── ROTA 1: Gerar URL de autorização ────────────────────────────────────────

router.get("/connect", requireAuth, (req, res) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const path      = "/api/v2/shop/auth_partner";
  const sign      = shopeeSign(path, timestamp);
  const state     = createSignedState(req.user.id);

  const url = new URL(`${SHOPEE_BASE}${path}`);
  url.searchParams.set("partner_id", String(PARTNER_ID));
  url.searchParams.set("timestamp",  String(timestamp));
  url.searchParams.set("sign",       sign);
  url.searchParams.set("redirect",   `${REDIRECT_URI}?state=${state}`);

  console.log(`[Shopee] URL de autorização gerada: ${url.toString()}`);
  return res.json({ url: url.toString() });
});

// ─── ROTA 2: Callback OAuth ───────────────────────────────────────────────────

router.get("/callback", async (req, res) => {
  const { code, shop_id, state } = req.query as Record<string, string>;

  const verified = verifySignedState(state ?? "");
  if (!verified) {
    return res.status(400).json({ message: "State inválido ou expirado." });
  }

  if (!code || !shop_id) {
    return res.status(400).json({ message: "Parâmetros code e shop_id são obrigatórios." });
  }

  try {
    // Troca code por tokens
    const path      = "/api/v2/auth/token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign      = shopeeSign(path, timestamp);

    const tokenRes = await axios.post(`${SHOPEE_BASE}${path}`, {
      code,
      shop_id:    parseInt(shop_id),
      partner_id: PARTNER_ID,
    }, {
      params: { partner_id: PARTNER_ID, timestamp, sign },
    });

    const { access_token, refresh_token, expire_in } = tokenRes.data;
    if (!access_token || !refresh_token) {
      console.error("[Shopee OAuth] Tokens inválidos:", tokenRes.data);
      return res.status(502).json({ message: "Shopee não retornou tokens válidos." });
    }

    const tokenExpiresAt = new Date(Date.now() + expire_in * 1000);

    // Busca nickname da loja
    let externalNickname: string | null = null;
    try {
      const shopPath = "/api/v2/shop/get_shop_info";
      const shopTs   = Math.floor(Date.now() / 1000);
      const shopSign = shopeeSign(shopPath, shopTs, access_token, shop_id);

      const shopRes = await axios.get(`${SHOPEE_BASE}${shopPath}`, {
        params: {
          partner_id:   PARTNER_ID,
          timestamp:    shopTs,
          sign:         shopSign,
          access_token: access_token,
          shop_id:      parseInt(shop_id),
        },
      });
      externalNickname = shopRes.data?.shop_name ?? null;
    } catch (err: any) {
      console.warn("[Shopee OAuth] Erro ao buscar shop info:", err?.response?.data ?? err?.message);
    }

    // Cria ou atualiza ChannelAccount
    const account = await prisma.channelAccount.upsert({
      where: {
        userId_channelType_externalAccountId: {
          userId:            verified.userId,
          channelType:       "SHOPEE",
          externalAccountId: shop_id,
        },
      },
      create: {
        userId:            verified.userId,
        channelType:       "SHOPEE",
        externalAccountId: shop_id,
        accessTokenEnc:    encrypt(access_token),
        refreshTokenEnc:   encrypt(refresh_token),
        tokenExpiresAt,
        externalNickname,
        apelido:           externalNickname,
      },
      update: {
        accessTokenEnc:  encrypt(access_token),
        refreshTokenEnc: encrypt(refresh_token),
        tokenExpiresAt,
        externalNickname,
      },
    });

    console.log(`[Shopee OAuth] Conta conectada: ${externalNickname ?? shop_id} (userId: ${verified.userId})`);

    // Dispara backfill se ainda não foi feito
    if (!account.initialSyncDone) {
      triggerBackfillAsync(account.id);
    }

    // Redireciona pro frontend
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    return res.redirect(`${frontendUrl}/dashboard/profile?shopee=connected`);

  } catch (err: any) {
    console.error("[Shopee OAuth] Erro:", err?.response?.data ?? err?.message);
    return res.status(500).json({ message: "Erro ao conectar conta Shopee." });
  }
});

export default router;