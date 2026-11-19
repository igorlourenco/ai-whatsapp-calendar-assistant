/*
 * Signup page session: after the WhatsApp code, the page holds a short-lived
 * token proving it owns that number (needed to connect iCloud or delete the
 * account). Stateless: "<phone>.<expiresAt>.<HMAC>", key derived from
 * CREDENTIALS_KEY. Sent as a Bearer header (never a cookie: no CSRF).
 */

export const SESSION_TTL_MS = 30 * 60_000;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error("CREDENTIALS_KEY is required for signup sessions");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`signup-session:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(secret: string | undefined, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}

/** phone = digits as WhatsApp addresses them (what parsePhone returns). */
export async function createSession(secret: string | undefined, phone: string, now = Date.now()): Promise<string> {
  const payload = `${phone}.${now + SESSION_TTL_MS}`;
  return `${payload}.${await sign(secret, payload)}`;
}

/** The phone the token was issued for, or null (bad signature, expired, malformed). */
export async function readSession(secret: string | undefined, token: string | null | undefined, now = Date.now()): Promise<string | null> {
  const m = /^(\d{10,15})\.(\d{13})\.([\w-]{43})$/.exec(token ?? "");
  if (!m) return null;
  const [, phone, exp] = m;
  if (Number(exp) <= now) return null;
  const sigBytes = Uint8Array.from(atob(m[3]!.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, new TextEncoder().encode(`${phone}.${exp}`));
  return ok ? phone! : null;
}
