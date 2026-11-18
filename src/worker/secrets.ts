/*
 * At-rest encryption for per-user credentials (iCloud app passwords) kept in
 * a Durable Object's SQLite. AES-256-GCM, key = CREDENTIALS_KEY (base64, 32
 * bytes). `pnpm db` / exports only ever see ciphertext.
 */

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function key(keyB64: string | undefined): Promise<CryptoKey> {
  let raw = new Uint8Array();
  try {
    if (keyB64) raw = unb64(keyB64);
  } catch {
    // invalid base64: same message below
  }
  if (raw.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** "v1.<iv>.<ciphertext>" */
export async function seal(keyB64: string | undefined, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(keyB64), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function open(keyB64: string | undefined, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unknown sealed format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(keyB64), unb64(ct));
  return new TextDecoder().decode(pt);
}
