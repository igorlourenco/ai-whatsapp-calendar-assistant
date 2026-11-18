import { asc, eq } from "drizzle-orm";

import { normText } from "./calendar/store";
import { GUEST_CATEGORIES } from "./calendar/sqlite-store";
import { settings, type Settings } from "./config";
import type { Db } from "./db/client";
import { categories, profile, users, type Profile, type User } from "./db/schema";
import { canonPhone, digits } from "./zapi";

/*
 * Multi-user: every person has their own Durable Object (own SQLite, alarm,
 * inbox, state). The owner keeps "main" with events in iCloud; everyone else
 * joins with the invite code and gets events in their object's SQLite, shown
 * on their phone through a read-only ICS feed. The "registry" object only
 * keeps the users table (who may talk to the bot, and feed tokens).
 */

/* ------------------------------- registry ------------------------------- */

export async function findUser(db: Db, phone: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.phone, canonPhone(phone))).limit(1);
  return row ?? null;
}

export async function findUserByToken(db: Db, token: string): Promise<User | null> {
  if (!/^[a-f0-9]{32,}$/.test(token)) return null;
  const [row] = await db.select().from(users).where(eq(users.icsToken, token)).limit(1);
  return row ?? null;
}

export async function listUsers(db: Db): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.createdAt));
}

/** Add a user (no-op when already registered). Returns the stored row. */
export async function addUser(db: Db, phone: string, name: string | null): Promise<User> {
  const key = canonPhone(phone);
  const token = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.insert(users).values({ phone: key, name, icsToken: token }).onConflictDoNothing();
  return (await findUser(db, key))!;
}

export async function removeUser(db: Db, phone: string): Promise<boolean> {
  const res = await db.delete(users).where(eq(users.phone, canonPhone(phone))).returning({ phone: users.phone });
  return res.length > 0;
}

/** The message carries the invite code (as a word, case/accents ignored). */
export function hasInvite(text: string, code: string | undefined): boolean {
  const c = normText(code ?? "");
  if (c.length < 4) return false; // no code configured (or too weak) → nobody joins
  return ` ${normText(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${c} `);
}

/* -------------------------------- profile ------------------------------- */

export async function loadProfile(db: Db): Promise<Profile | null> {
  const [row] = await db.select().from(profile).where(eq(profile.id, 1)).limit(1);
  return row ?? null;
}

export type ProfilePatch = Partial<Pick<Profile, "tz" | "morningAt" | "eveningAt" | "defaultReminder" | "taskNagMinutes" | "name">>;

/** Change settings. The owner's object gets a row on its first change. */
export async function updateProfile(db: Db, patch: ProfilePatch): Promise<Profile> {
  await db.insert(profile).values({ id: 1, ...patch }).onConflictDoUpdate({ target: profile.id, set: patch });
  return (await loadProfile(db))!;
}

/** First message of a new user: profile + starter categories. Idempotent. */
export async function setupGuest(db: Db, phone: string, name: string | null, feedUrl: string): Promise<void> {
  await db
    .insert(profile)
    .values({ id: 1, phone: digits(phone), name, storage: "local", feedUrl })
    .onConflictDoUpdate({ target: profile.id, set: { feedUrl } });
  if ((await db.select().from(categories).limit(1)).length) return;
  await db.insert(categories).values(
    GUEST_CATEGORIES.map((c, i) => ({ ...c, color: ["#1BADF8", "#FF9500", "#CC73E1"][i]! })),
  );
}

/** Deployment settings (env) overridden by this user's choices. */
export function userSettings(env: Parameters<typeof settings>[0], p: Profile | null): Settings {
  const base = settings(env);
  if (!p) return base;
  return {
    ...base,
    tz: p.tz ?? base.tz,
    morningAt: p.morningAt ?? base.morningAt,
    eveningAt: p.eveningAt ?? base.eveningAt,
    defaultReminder: p.defaultReminder ?? base.defaultReminder,
    taskNagMinutes: p.taskNagMinutes ?? base.taskNagMinutes,
  };
}

export const isGuest = (p: Profile | null) => p?.storage === "local";
