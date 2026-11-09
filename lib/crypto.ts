import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ---------- AES-256-GCM for secrets at rest (Instagram tokens, webhook secrets) ----------

function encryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set (32 random bytes, base64)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

/** Returns `v1:<iv>:<tag>:<ciphertext>` (base64url parts). The version prefix allows key rotation later. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, data] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

// ---------- API keys ----------

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Key format: sp_live_<prefix>_<secret>. Prefix is stored in clear for lookup; the full key only as a SHA-256 hash. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const key = `sp_live_${prefix}_${secret}`;
  return { key, prefix, hash: sha256(key) };
}

export function parseApiKey(key: string): { prefix: string } | null {
  const m = /^sp_live_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/.exec(key.trim());
  return m ? { prefix: m[1] } : null;
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Random URL-safe token (invites, iCal feeds). Store only sha256(token). */
export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url");
