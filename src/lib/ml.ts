// src/lib/ml.ts

import axios from "axios";
import prisma from "./prisma";
import { encrypt, decrypt } from "./crypto";

const ML_BASE = "https://api.mercadolibre.com";
const CLIENT_ID = process.env.ML_CLIENT_ID!;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET!;

export function getMlClient(accessToken: string) {
  return axios.create({
    baseURL: ML_BASE,
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
}

export async function refreshToken(tokenId: number) {
  const tokenRecord = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!tokenRecord) throw new Error("Token not found");

  const res = await axios.post(`${ML_BASE}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokenRecord.refreshToken,
  });

  const expiresAt = new Date(Date.now() + res.data.expires_in * 1000);
  const updated = await prisma.token.update({
    where: { id: tokenId },
    data: {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresAt,
    },
  });
  console.log(`[ML] Token #${tokenId} renovado. Expira em: ${expiresAt.toISOString()}`);
  return updated;
}

const refreshInFlight = new Map<number, Promise<any>>();

export async function getValidToken(tokenId: number) {
  let tokenRecord = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!tokenRecord) throw new Error("Token not found");

  const expiresInMs = tokenRecord.expiresAt.getTime() - Date.now();
  if (expiresInMs < 60 * 60 * 1000) {
    if (!refreshInFlight.has(tokenId)) {
      const promise = refreshToken(tokenId).finally(() => refreshInFlight.delete(tokenId));
      refreshInFlight.set(tokenId, promise);
    }
    tokenRecord = await refreshInFlight.get(tokenId)!;
  }
  return tokenRecord;
}

// ─── REFRESH DE ChannelAccount (novo motor) ───────────────────────────────────

async function refreshChannelAccount(accountId: string): Promise<void> {
  const account = await prisma.channelAccount.findUnique({ where: { id: accountId } });
  if (!account) return;

  const refreshTokenValue = decrypt(account.refreshTokenEnc);

  const res = await axios.post(`${ML_BASE}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshTokenValue,
  });

  const expiresAt = new Date(Date.now() + res.data.expires_in * 1000);

  await prisma.channelAccount.update({
    where: { id: accountId },
    data: {
      accessTokenEnc:  encrypt(res.data.access_token),
      refreshTokenEnc: encrypt(res.data.refresh_token),
      tokenExpiresAt:  expiresAt,
    },
  });

  console.log(`[ML] ChannelAccount ${accountId} renovada. Expira em: ${expiresAt.toISOString()}`);
}

// ─── JOB DE RENOVAÇÃO AUTOMÁTICA ─────────────────────────────────────────────
// Roda a cada 5 horas — renova tokens que expiram nas próximas 2 horas

export async function runTokenRefreshJob() {
  console.log("[TokenRefreshJob] Verificando tokens...");
  const in2Hours = new Date(Date.now() + 2 * 60 * 60 * 1000);

  // ── Tabela Token antiga (compatibilidade) ──────────────────────────────────
  const tokens = await prisma.token.findMany({
    where: { expiresAt: { lte: in2Hours } },
  });

  console.log(`[TokenRefreshJob] ${tokens.length} token(s) legado(s) para renovar`);

  for (const token of tokens) {
    try {
      await refreshToken(token.id);
    } catch (err: any) {
      console.error(`[TokenRefreshJob] Falha ao renovar token #${token.id}:`, err?.message);
      await prisma.adminAlert.create({
        data: {
          type: "token_refresh_failed",
          severity: "critical",
          clientId: token.userId,
          tokenId: token.id,
          description: `Falha ao renovar token da conta '${token.apelido ?? token.mlNickname ?? `#${token.id}`}'. Reconexão necessária.`,
        },
      }).catch(() => {});
    }
  }

  // ── ChannelAccount novo motor ──────────────────────────────────────────────
  const channelAccounts = await prisma.channelAccount.findMany({
    where: {
      channelType:   "MERCADO_LIVRE",
      tokenExpiresAt: { lte: in2Hours },
    },
  });

  console.log(`[TokenRefreshJob] ${channelAccounts.length} ChannelAccount(s) ML para renovar`);

  for (const account of channelAccounts) {
    try {
      await refreshChannelAccount(account.id);
    } catch (err: any) {
      console.error(`[TokenRefreshJob] Falha ao renovar ChannelAccount ${account.id}:`, err?.message);
      await prisma.adminAlert.create({
        data: {
          type:        "token_refresh_failed",
          severity:    "critical",
          clientId:    account.userId,
          description: `Falha ao renovar token da conta ML '${account.apelido ?? account.externalNickname ?? account.id}'. Reconexão necessária.`,
        },
      }).catch(() => {});
    }
  }

  console.log("[TokenRefreshJob] Concluído");
}

export function buildOAuthUrl(state: string): string {
  const redirectUri = process.env.ML_REDIRECT_URI!;
  return `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
}

export async function exchangeCode(code: string): Promise<any> {
  const redirectUri = process.env.ML_REDIRECT_URI!;
  const res = await axios.post(`${ML_BASE}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  return res.data;
}