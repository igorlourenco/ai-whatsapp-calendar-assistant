import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { loginRequests } from "./db/schema";
import { digits } from "./zapi";

/*
 * Login for the signup page (GET /), WhatsApp-first: the page asks for a
 * code, the person sends "entrar <code>" to the bot (wa.me link with the
 * text filled in), and the page, polling with its secret id, gets a session
 * for the number that sent it.
 *
 * The bot never messages a number first. WhatsApp restricts accounts that
 * start chats with strangers (it did, when the page used to send codes), so
 * every message the bot sends is a reply in a chat the person opened.
 */

export const LOGIN_TTL_MS = 10 * 60_000;
/** All pending logins together, per hour (keeps the table small under abuse). */
export const MAX_LOGINS_PER_HOUR = 500;
const HOUR_MS = 60 * 60_000;

/** No 0/O, 1/I/L: easy to read on screen and to type by hand. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

function randomCode(): string {
  const buf = new Uint8Array(CODE_LEN * 2);
  crypto.getRandomValues(buf);
  let out = "";
  // 248 = 8 × 31: rejection keeps the alphabet uniform.
  for (const b of buf) if (b < 248 && out.length < CODE_LEN) out += ALPHABET[b % ALPHABET.length];
  return out.length === CODE_LEN ? out : randomCode();
}

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The text the wa.me link fills in. */
export const loginText = (code: string) => `Entrar na agenda: ${code}`;

/**
 * The login code in a WhatsApp message, if it is one ("Entrar na agenda:
 * K7M2QX", "entrar k7m2qx"). Needs the word "entrar" so ordinary messages
 * never hit the registry.
 */
export function loginCodeIn(text: string): string | null {
  const t = text.normalize("NFKC").trim();
  if (t.length > 80 || !/\bentrar\b/i.test(t)) return null;
  // The last standalone 6-char token: "agenda" in the filled-in text is one too.
  const tokens = t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length === CODE_LEN && new RegExp(`^[${ALPHABET}]+$`, "i").test(w));
  return tokens.length ? tokens[tokens.length - 1]!.toUpperCase() : null;
}

export type LoginStart = { ok: true; id: string; code: string; expiresAt: number } | { ok: false };

export async function startLogin(db: Db, now = new Date()): Promise<LoginStart> {
  const t = now.getTime();
  await db.delete(loginRequests).where(lt(loginRequests.expiresAt, new Date(t - HOUR_MS)));
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(loginRequests)
    .where(gt(loginRequests.createdAt, new Date(t - HOUR_MS)))) as [{ n: number }];
  if (Number(n) >= MAX_LOGINS_PER_HOUR) return { ok: false };
  for (let i = 0; i < 5; i++) {
    const row = { id: hex(24), code: randomCode(), expiresAt: new Date(t + LOGIN_TTL_MS), createdAt: now };
    const ins = await db.insert(loginRequests).values(row).onConflictDoNothing().returning({ id: loginRequests.id });
    if (ins.length) return { ok: true, id: row.id, code: row.code, expiresAt: row.expiresAt.getTime() };
  }
  return { ok: false };
}

/** A WhatsApp message carried this code: bind the sender. False if unknown, expired or already used. */
export async function claimLogin(db: Db, code: string, phone: string, now = new Date()): Promise<boolean> {
  const res = await db
    .update(loginRequests)
    .set({ phone: digits(phone) })
    .where(and(eq(loginRequests.code, code.toUpperCase()), isNull(loginRequests.phone), gt(loginRequests.expiresAt, now)))
    .returning({ id: loginRequests.id });
  return res.length > 0;
}

export type LoginPoll = { status: "pending" } | { status: "expired" } | { status: "ok"; phone: string };

/** The page asks whether its code arrived. "ok" is returned once (the session is single use). */
export async function pollLogin(db: Db, id: string, now = new Date()): Promise<LoginPoll> {
  if (!/^[a-f0-9]{48}$/.test(id)) return { status: "expired" };
  const [row] = await db.select().from(loginRequests).where(eq(loginRequests.id, id)).limit(1);
  if (!row || row.consumed) return { status: "expired" };
  if (!row.phone) return row.expiresAt.getTime() > now.getTime() ? { status: "pending" } : { status: "expired" };
  const took = await db
    .update(loginRequests)
    .set({ consumed: true })
    .where(and(eq(loginRequests.id, id), eq(loginRequests.consumed, false)))
    .returning({ phone: loginRequests.phone });
  return took[0]?.phone ? { status: "ok", phone: took[0].phone } : { status: "expired" };
}
