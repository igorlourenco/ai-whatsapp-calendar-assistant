import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/*
 * Lives in the Scheduler Durable Object's embedded SQLite (one instance,
 * single user). Events themselves live in iCloud; this is control state only.
 * Timestamps are epoch-ms integers; JSON columns are text.
 */

const now = () => new Date();
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export type Recurrence = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  /** Every N units (default 1). */
  interval?: number;
  /** Weekly only: 0=Sun … 6=Sat. Defaults to the start's weekday. */
  byWeekday?: number[];
  /** Last local date (YYYY-MM-DD, inclusive) an occurrence may start on. */
  until?: string;
  /** Max number of occurrences. */
  count?: number;
};

/** Category ↔ iCloud calendar, plus the emoji shown on WhatsApp. */
export const categories = sqliteTable("categories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** Lowercase, accent-free key the model refers to (e.g. "faculdade"). */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull(),
  /** Hex color (mirrors the iCloud calendar color). */
  color: text("color").notNull().default("#64748b"),
  /** iCloud calendar collection URL. */
  calendarUrl: text("calendar_url").unique(),
  createdAt: ts("created_at").notNull().$defaultFn(now),
});

/** One row per reminder sent (claimed before sending, released on failure). */
export const reminderLog = sqliteTable(
  "reminder_log",
  {
    /** Store event id (iCloud object URL). */
    eventId: text("event_id").notNull(),
    occurrenceStart: ts("occurrence_start").notNull(),
    sentAt: ts("sent_at").notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.occurrenceStart] })],
);

export const digestLog = sqliteTable(
  "digest_log",
  {
    kind: text("kind").$type<"morning" | "evening">().notNull(),
    /** YYYY-MM-DD in the configured timezone. */
    localDate: text("local_date").notNull(),
    sentAt: ts("sent_at").notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.kind, t.localDate] })],
);

/**
 * Durable inbox. The webhook hands each message to the Durable Object, which
 * stores it here (deduped on Z-API messageId) and processes rows in order:
 *   pending → (model ran, reply stored) answered → (WhatsApp sent) done
 *   any step failing MAX_ATTEMPTS times → failed (user is told explicitly)
 * Storing the reply before sending means a send retry never re-runs the model.
 */
export const inboundMessages = sqliteTable(
  "inbound_messages",
  {
    messageId: text("message_id").primaryKey(),
    phone: text("phone").notNull().default(""),
    text: text("text").notNull().default(""),
    status: text("status").$type<"pending" | "answered" | "done" | "failed">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    reply: text("reply"),
    lastError: text("last_error"),
    nextAttemptAt: ts("next_attempt_at").notNull().$defaultFn(now),
    receivedAt: ts("received_at").notNull().$defaultFn(now),
    processedAt: ts("processed_at"),
  },
  (t) => [index("inbound_status_idx").on(t.status, t.receivedAt)],
);

/**
 * Events created while handling a WhatsApp message. Lets the failure notice
 * say exactly what got saved before something broke.
 */
export const messageEvents = sqliteTable(
  "message_events",
  {
    messageId: text("message_id").notNull(),
    eventId: text("event_id").notNull(),
    label: text("label").notNull(),
    createdAt: ts("created_at").notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.eventId] })],
);

/**
 * Structured conversation state (single row, id=1). NOT a chat transcript:
 * the model never sees past replies, only these code-built facts.
 * - draft: an incomplete create waiting for missing fields (e.g. the date)
 * - pick: a "qual deles?" question waiting for the user's choice
 * - focus: events recently created/changed/listed, exposed to the model as
 *   E1, E2… so "muda pra 16h" / "apaga esse" / "o segundo" resolve.
 */
export type DraftCreate = {
  title: string;
  date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  last_date?: string | null;
  category?: string | null;
  location?: string | null;
  notes?: string | null;
  recurrence?: Recurrence | null;
  reminder_minutes?: number | null;
};
export type FocusItem = { eventId: string; occurrenceStart: string; label: string };
export type PendingPick =
  | { action: "delete"; only_that_day?: boolean | null }
  | { action: "update"; changes: Record<string, unknown> };

export const assistantState = sqliteTable("assistant_state", {
  id: integer("id").primaryKey().default(1),
  draft: text("draft", { mode: "json" }).$type<DraftCreate | null>(),
  pick: text("pick", { mode: "json" }).$type<PendingPick | null>(),
  draftAt: ts("draft_at"),
  focus: text("focus", { mode: "json" }).$type<FocusItem[]>().notNull().default([]),
  focusAt: ts("focus_at"),
});

export type Category = typeof categories.$inferSelect;
