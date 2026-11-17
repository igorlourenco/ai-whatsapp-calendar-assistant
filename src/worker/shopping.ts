import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { matchTitles, normText } from "./calendar/store";
import type { Db } from "./db/client";
import { shoppingItems, type ShoppingItem } from "./db/schema";

/*
 * Shopping list: one list, no dates, no nags. Lives in the Durable Object's
 * SQLite next to tasks. Every reply is built from rows re-read here.
 */

const STOP = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "um", "uma", "e", "pra", "para", "lista"]);

/** Open items, oldest first; rowid keeps the order of items sent in one message. */
export async function openItems(db: Db): Promise<ShoppingItem[]> {
  return db.select().from(shoppingItems).where(eq(shoppingItems.status, "open")).orderBy(asc(shoppingItems.createdAt), sql`rowid`);
}

/** "leite" → "Leite"; trims and collapses spaces. */
export function cleanName(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Add items. An item already open (same name, accents/case ignored) is not
 * duplicated. Ids are per message + name, so a retried message is a no-op.
 */
export async function addItems(
  db: Db,
  names: string[],
  sourceMessageId?: string | null,
): Promise<{ added: ShoppingItem[]; existing: ShoppingItem[] }> {
  const open = await openItems(db);
  const byName = new Map(open.map((i) => [normText(i.name), i]));
  const addedIds: string[] = [];
  const existing: ShoppingItem[] = [];
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name) continue;
    const key = normText(name);
    const hit = byName.get(key);
    if (hit) {
      if (!addedIds.includes(hit.id) && !existing.includes(hit)) existing.push(hit);
      continue;
    }
    const id = sourceMessageId ? `${sourceMessageId}:${key}` : crypto.randomUUID();
    await db.insert(shoppingItems).values({ id, name }).onConflictDoNothing();
    addedIds.push(id);
    byName.set(key, { id, name, status: "open", createdAt: new Date(), boughtAt: null });
  }
  const added = addedIds.length ? await db.select().from(shoppingItems).where(inArray(shoppingItems.id, addedIds)) : [];
  if (added.length !== addedIds.length) throw new Error("write verification failed: shopping items not found after insert");
  return { added: addedIds.map((id) => added.find((a) => a.id === id)!), existing };
}

/**
 * Which open item the user means by `name`: exact name first ("leite" is not
 * "leite condensado"), then the usual word / word-root match.
 */
export function findItem(open: ShoppingItem[], name: string): ShoppingItem[] {
  const key = normText(name);
  const exact = open.filter((i) => normText(i.name) === key);
  if (exact.length) return exact;
  return matchTitles(open, (i) => i.name, name, STOP);
}

export async function markBought(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db
    .update(shoppingItems)
    .set({ status: "bought", boughtAt: new Date() })
    .where(and(inArray(shoppingItems.id, ids), eq(shoppingItems.status, "open")));
}

export async function removeItems(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.delete(shoppingItems).where(inArray(shoppingItems.id, ids));
}

/** "🛒 *Lista de compras* (3)\n• Leite\n• Ovos…" */
export function formatShoppingList(items: ShoppingItem[]): string {
  if (!items.length) return "🛒 Lista de compras vazia ✨";
  return `🛒 *Lista de compras* (${items.length})\n${items.map((i) => `• ${i.name}`).join("\n")}`;
}

/** "leite, ovos e pão" */
export function joinNames(items: { name: string }[]): string {
  const n = items.map((i) => i.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} e ${n.at(-1)}`;
}
