import axios from "axios";
import prisma from "./prisma";

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

export async function getValidToken(tokenId: number) {
  let tokenRecord = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!tokenRecord) throw new Error("Token not found");

  // Renova se expira em menos de 1 hora
  const expiresInMs = tokenRecord.expiresAt.getTime() - Date.now();
  if (expiresInMs < 60 * 60 * 1000) {
    tokenRecord = await refreshToken(tokenId);
  }
  return tokenRecord;
}

// Job de renovação automática — roda a cada 5 horas
// Renova todos os tokens que expiram nas próximas 2 horas
export async function runTokenRefreshJob() {
  console.log("[TokenRefreshJob] Verificando tokens...");
  const in2Hours = new Date(Date.now() + 2 * 60 * 60 * 1000);

  const tokens = await prisma.token.findMany({
    where: { expiresAt: { lte: in2Hours } },
  });

  console.log(`[TokenRefreshJob] ${tokens.length} token(s) para renovar`);

  for (const token of tokens) {
    try {
      await refreshToken(token.id);
    } catch (err: any) {
      console.error(`[TokenRefreshJob] Falha ao renovar token #${token.id}:`, err?.message);
      // Cria alerta para o admin
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