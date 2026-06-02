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
  return updated;
}

export async function getValidToken(tokenId: number) {
  let tokenRecord = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!tokenRecord) throw new Error("Token not found");

  // Refresh if expires within 10 minutes
  const expiresInMs = tokenRecord.expiresAt.getTime() - Date.now();
  if (expiresInMs < 10 * 60 * 1000) {
    tokenRecord = await refreshToken(tokenId);
  }
  return tokenRecord;
}

export function buildOAuthUrl(state: string): string {
  const redirectUri = process.env.ML_REDIRECT_URI!;
  return `${ML_BASE}/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
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
