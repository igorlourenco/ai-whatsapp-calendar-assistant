import { and, eq, gt, lt, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { signupCodes } from "./db/schema";
import { canonPhone, digits } from "./zapi";

/*
 * Open signup (the page at GET /): anyone proves they own a WhatsApp number
 * with a one-time code the bot sends there, and joins like an invite-code
 * user. The code bookkeeping lives in the "registry" object.
 *
 * Abuse limits: the page makes the bot message numbers typed by strangers,
 * so sends are capped per number, per IP (rate-limit binding, index.ts) and
 * per deployment, to keep the Z-API number from looking like a spammer.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const RESEND_AFTER_MS = 60_000;
export const MAX_SENDS_PER_DAY = 5;
export const MAX_ATTEMPTS = 5;
/** All numbers together, per rolling 24 h. */
export const GLOBAL_SENDS_PER_DAY = 200;
const DAY_MS = 24 * 60 * 60_000;

/**
 * What the person typed → digits with country code, as WhatsApp addresses
 * it. "+…" is taken as is; 10–11 digits without "+" are Brazilian (DDD +
 * number). Null when it can't be a phone number.
 */
export function parsePhone(input: string): string | null {
  const raw = input.trim();
  let d = digits(raw);
  if (!raw.startsWith("+") && !d.startsWith("00") && (d.length === 10 || d.length === 11)) d = `55${d}`;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 10 || d.length > 15 || d.startsWith("0")) return null;
  // Brazilian numbers: 55 + DDD (2) + 8–9 digits.
  if (d.startsWith("55") && (d.length < 12 || d.length > 13)) return null;
  return d;
}

async function hash(phone: string, code: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${canonPhone(phone)}:${code}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newCode(): string {
  // Rejection sampling: uniform over 000000–999999.
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= 4_294_000_000);
  return String(buf[0]! % 1_000_000).padStart(6, "0");
}

export type CodeRequest =
  | { ok: true; code: string }
  | { ok: false; reason: "wait"; seconds: number }
  | { ok: false; reason: "limit" | "busy" };

/** A fresh code for this number (replaces any previous one), or why not. */
export async function requestCode(db: Db, phone: string, now = new Date()): Promise<CodeRequest> {
  const key = canonPhone(phone);
  const t = now.getTime();
  await db.delete(signupCodes).where(lt(signupCodes.windowStart, new Date(t - 2 * DAY_MS)));

  const [row] = await db.select().from(signupCodes).where(eq(signupCodes.phone, key)).limit(1);
  if (row && t - row.lastSentAt.getTime() < RESEND_AFTER_MS) {
    return { ok: false, reason: "wait", seconds: Math.ceil((RESEND_AFTER_MS - (t - row.lastSentAt.getTime())) / 1000) };
  }
  const sameWindow = row && t - row.windowStart.getTime() < DAY_MS;
  if (sameWindow && row.sends >= MAX_SENDS_PER_DAY) return { ok: false, reason: "limit" };

  const [{ total }] = (await db
    .select({ total: sql<number>`coalesce(sum(${signupCodes.sends}), 0)` })
    .from(signupCodes)
    .where(gt(signupCodes.windowStart, new Date(t - DAY_MS)))) as [{ total: number }];
  if (Number(total) >= GLOBAL_SENDS_PER_DAY) return { ok: false, reason: "busy" };

  const code = newCode();
  const values = {
    codeHash: await hash(key, code),
    expiresAt: new Date(t + CODE_TTL_MS),
    attempts: 0,
    sends: sameWindow ? row.sends + 1 : 1,
    windowStart: sameWindow ? row.windowStart : now,
    lastSentAt: now,
  };
  await db.insert(signupCodes).values({ phone: key, ...values }).onConflictDoUpdate({ target: signupCodes.phone, set: values });
  return { ok: true, code };
}

/** Undo a send that never reached Z-API, so it doesn't count against the limits. */
export async function cancelCode(db: Db, phone: string): Promise<void> {
  const key = canonPhone(phone);
  await db
    .update(signupCodes)
    .set({ codeHash: null, sends: sql`max(${signupCodes.sends} - 1, 0)`, lastSentAt: new Date(0) })
    .where(eq(signupCodes.phone, key));
}

export type CodeCheck = "ok" | "wrong" | "expired" | "locked";

/** Check a code. Right → consumed (single use). Wrong → counts toward MAX_ATTEMPTS. */
export async function verifyCode(db: Db, phone: string, code: string, now = new Date()): Promise<CodeCheck> {
  const key = canonPhone(phone);
  const [row] = await db.select().from(signupCodes).where(eq(signupCodes.phone, key)).limit(1);
  if (!row?.codeHash || row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.attempts >= MAX_ATTEMPTS) return "locked";
  const clean = digits(code);
  if (clean.length === 6 && (await hash(key, clean)) === row.codeHash) {
    // Conditional on the hash: two racing correct guesses consume it once.
    const used = await db
      .update(signupCodes)
      .set({ codeHash: null })
      .where(and(eq(signupCodes.phone, key), eq(signupCodes.codeHash, row.codeHash)))
      .returning({ phone: signupCodes.phone });
    return used.length ? "ok" : "expired";
  }
  await db
    .update(signupCodes)
    .set({ attempts: row.attempts + 1 })
    .where(eq(signupCodes.phone, key));
  return row.attempts + 1 >= MAX_ATTEMPTS ? "locked" : "wrong";
}
