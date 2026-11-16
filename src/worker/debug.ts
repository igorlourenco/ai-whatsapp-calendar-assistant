import { desc, eq } from "drizzle-orm";

import type { Db } from "./db/client";
import {
  assistantState,
  categories,
  digestLog,
  inboundMessages,
  messageEvents,
  reminderLog,
  tasks,
} from "./db/schema";

/*
 * Ops surface for the Durable Object's SQLite (what the Neon console used to
 * give us): snapshot, read-only SQL, JSON export/import. Reached through
 * /debug/* routes guarded by DEBUG_TOKEN.
 */

const TABLES = {
  categories,
  inbound_messages: inboundMessages,
  assistant_state: assistantState,
  reminder_log: reminderLog,
  digest_log: digestLog,
  message_events: messageEvents,
  tasks,
} as const;

/** Timestamp columns per table (JSON carries them as ISO strings). */
const DATE_COLS: Record<keyof typeof TABLES, string[]> = {
  categories: ["createdAt"],
  inbound_messages: ["nextAttemptAt", "receivedAt", "processedAt"],
  assistant_state: ["draftAt", "focusAt", "batchAt", "taskFocusAt"],
  reminder_log: ["occurrenceStart", "sentAt"],
  digest_log: ["sentAt"],
  message_events: ["createdAt"],
  tasks: ["remindedAt", "createdAt", "doneAt"],
};

export type ExportData = { exportedAt: string; tables: Partial<Record<keyof typeof TABLES, Record<string, unknown>[]>> };

export async function snapshot(db: Db) {
  const clip = (s: string | null, n = 160) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
  const inbox = await db.select().from(inboundMessages).orderBy(desc(inboundMessages.receivedAt)).limit(20);
  return {
    inbox: inbox.map((m) => ({ ...m, text: clip(m.text), reply: clip(m.reply) })),
    state: (await db.select().from(assistantState))[0] ?? null,
    reminders: await db.select().from(reminderLog).orderBy(desc(reminderLog.sentAt)).limit(10),
    digests: await db.select().from(digestLog).orderBy(desc(digestLog.sentAt)).limit(10),
    categories: await db.select().from(categories),
    openTasks: await db.select().from(tasks).where(eq(tasks.status, "open")),
  };
}

class Rollback extends Error {}

/**
 * Ad-hoc SQL with a hard read-only guarantee: one statement, must start as a
 * query, and it runs inside a transaction that is ALWAYS rolled back, so even
 * a write smuggled through a CTE can't persist.
 */
export function readOnlyQuery(storage: DurableObjectStorage, sql: string) {
  const q = sql.trim().replace(/;\s*$/, "");
  if (!q) throw new Error("empty query");
  if (q.includes(";")) throw new Error("one statement only");
  if (!/^(select|with|explain|pragma\s+table_(info|list))\b/i.test(q)) {
    throw new Error("read-only: SELECT / WITH / EXPLAIN / PRAGMA table_info|table_list only");
  }
  let rows: Record<string, unknown>[] = [];
  try {
    storage.transactionSync(() => {
      rows = storage.sql.exec(q).toArray() as Record<string, unknown>[];
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return { rows: rows.slice(0, 500), count: rows.length, truncated: rows.length > 500 };
}

export async function exportAll(db: Db): Promise<ExportData> {
  const tables: ExportData["tables"] = {};
  for (const [name, table] of Object.entries(TABLES)) {
    tables[name as keyof typeof TABLES] = (await db.select().from(table)) as Record<string, unknown>[];
  }
  return { exportedAt: new Date().toISOString(), tables };
}

/** Insert-only: existing rows (same primary key) are kept untouched. */
export async function importAll(db: Db, data: ExportData) {
  const inserted: Record<string, number> = {};
  for (const [name, rows] of Object.entries(data.tables ?? {})) {
    const table = TABLES[name as keyof typeof TABLES];
    if (!table || !rows?.length) continue;
    const cols = DATE_COLS[name as keyof typeof TABLES];
    const values = rows.map((r) => {
      const v: Record<string, unknown> = { ...r };
      for (const c of cols) if (v[c] != null) v[c] = new Date(v[c] as string);
      return v;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await db.insert(table).values(values as any).onConflictDoNothing().returning();
    inserted[name] = (res as unknown[]).length;
  }
  return { inserted };
}

export type CategoryConfig = {
  slug: string;
  name: string;
  emoji: string;
  calendarUrl: string;
  color?: string | null;
  description?: string | null;
  isDefault?: boolean;
};

/**
 * Validate a category → iCloud calendar mapping (used by `pnpm configure`) and
 * build the rows. Exactly one category ends up as default. The caller writes
 * them atomically (delete + insert in one transaction).
 */
export function categoryRows(list: CategoryConfig[]) {
  if (!Array.isArray(list) || !list.length) throw new Error("at least one category is required");
  for (const c of list) {
    if (!c.slug || !c.name || !c.emoji || !c.calendarUrl) throw new Error(`incomplete category: ${JSON.stringify(c)}`);
  }
  if (new Set(list.map((c) => c.slug)).size !== list.length) throw new Error("duplicate slug");
  if (new Set(list.map((c) => c.calendarUrl)).size !== list.length) throw new Error("duplicate calendarUrl");
  const defaultSlug = list.find((c) => c.isDefault)?.slug ?? list[0]!.slug;
  const rows = list.map((c) => ({
    slug: c.slug,
    name: c.name,
    emoji: c.emoji,
    calendarUrl: c.calendarUrl,
    color: c.color ?? "#64748b",
    description: c.description ?? null,
    isDefault: c.slug === defaultSlug,
  }));
  return { rows, defaultSlug };
}
