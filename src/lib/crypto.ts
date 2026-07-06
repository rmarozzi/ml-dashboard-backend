// src/lib/crypto.ts
//
// Utilitário de criptografia para tokens OAuth armazenados em repouso.
// Usa AES-256-GCM com IV aleatório por operação.
// A chave vem da variável de ambiente TOKEN_ENCRYPTION_KEY (32 bytes em hex).

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY ?? "";

function getKey(): Buffer {
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY inválida. Deve ser uma string hex de 64 caracteres (32 bytes). " +
      "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(KEY_HEX, "hex");
}

/**
 * Criptografa um valor em texto puro.
 * Retorna uma string no formato: iv:authTag:ciphertext (tudo em hex).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96 bits — recomendado para GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Descriptografa um valor gerado por encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");

  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Formato de ciphertext inválido. Esperado: iv:authTag:ciphertext");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}