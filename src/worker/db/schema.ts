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
  /** Lowercase, accent-free key the model refers to (e.g. "work"). */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull(),
  /** Hex color (mirrors the iCloud calendar color). */
  color: text("color").notNull().default("#64748b"),
  /** iCloud calendar collection URL. */
  calendarUrl: text("calendar_url").unique(),
  /** What belongs here, in the user's words; shown to the model to pick a category. */
  description: text("description"),
  /** Where events go when the message doesn't fit any category. */
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
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
    /** Attached image (Z-API temporary URL) and its MIME type, if any. */
    mediaUrl: text("media_url"),
    mediaMime: text("media_mime"),
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
  /** "task": a create_task waiting for its due date. Default: an event. */
  kind?: "task";
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
/** A task recently created/changed/listed, exposed to the model as T1, T2… */
export type TaskRef = { taskId: string; label: string };
export type PendingPick =
  | { action: "delete"; only_that_day?: boolean | null }
  | { action: "update"; changes: Record<string, unknown> }
  | { action: "complete_task" }
  | { action: "delete_task" }
  | { action: "update_task"; changes: Record<string, unknown> };

/**
 * Events read from an image, shown to the user as a numbered preview and NOT
 * saved until they answer "sim" / "não" / "1,3". items are validated create
 * actions (see llm/extract.ts).
 */
export type PendingBatch = { messageId: string; createdAt: string; items: Record<string, unknown>[] };

export const assistantState = sqliteTable("assistant_state", {
  id: integer("id").primaryKey().default(1),
  draft: text("draft", { mode: "json" }).$type<DraftCreate | null>(),
  pick: text("pick", { mode: "json" }).$type<PendingPick | null>(),
  draftAt: ts("draft_at"),
  focus: text("focus", { mode: "json" }).$type<FocusItem[]>().notNull().default([]),
  focusAt: ts("focus_at"),
  batch: text("batch", { mode: "json" }).$type<PendingBatch | null>(),
  batchAt: ts("batch_at"),
  taskFocus: text("task_focus", { mode: "json" }).$type<TaskRef[]>().notNull().default([]),
  taskFocusAt: ts("task_focus_at"),
  /** Which numbered list the user saw last, so a bare "o 2" means E2 or T2. */
  lastList: text("last_list").$type<"events" | "tasks">(),
});

/**
 * To-dos ("pagar boleto sexta", "me lembra de ligar pro banco 10h"). Unlike
 * events they live here, not in iCloud: Apple doesn't expose the current
 * Reminders app over CalDAV. A task has an optional due date/time, can
 * repeat, and stays open until marked done.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    /** `<messageId>:<normalized title>` when created from a message (idempotent retries). */
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    /** YYYY-MM-DD in the configured timezone; null = no date. */
    dueDate: text("due_date"),
    /** HH:mm local; when set, a WhatsApp nag is sent at that time. */
    dueTime: text("due_time"),
    /** Repeating task: marking it done moves it to the next due date. */
    recurrence: text("recurrence", { mode: "json" }).$type<Recurrence | null>(),
    notes: text("notes"),
    status: text("status").$type<"open" | "done">().notNull().default("open"),
    /** Nag sent for the current due time (cleared whenever the due changes). */
    remindedAt: ts("reminded_at"),
    createdAt: ts("created_at").notNull().$defaultFn(now),
    doneAt: ts("done_at"),
  },
  (t) => [index("tasks_status_due_idx").on(t.status, t.dueDate)],
);

export type Task = typeof tasks.$inferSelect;

export type Category = typeof categories.$inferSelect;

/**
 * Shopping list ("compra leite e ovos", "comprei o leite"). One list, no
 * dates, no nags: a dated purchase is a task instead. Bought items are kept
 * (status "bought") so the history survives; the list shows open ones only.
 */
export const shoppingItems = sqliteTable(
  "shopping_items",
  {
    /** `<messageId>:<normalized name>` when created from a message (idempotent retries). */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").$type<"open" | "bought">().notNull().default("open"),
    createdAt: ts("created_at").notNull().$defaultFn(now),
    boughtAt: ts("bought_at"),
  },
  (t) => [index("shopping_status_idx").on(t.status, t.createdAt)],
);

export type ShoppingItem = typeof shoppingItems.$inferSelect;
