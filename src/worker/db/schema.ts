import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Lowercase, accent-free key the LLM refers to (e.g. "faculdade"). */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull(),
  /** Hex color (mirrors the iCloud calendar color). */
  color: text("color").notNull().default("#64748b"),
  /** iCloud calendar collection URL this category maps to (production store). */
  calendarUrl: text("calendar_url").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    notes: text("notes"),
    location: text("location"),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    allDay: boolean("all_day").notNull().default(false),
    /**
     * Timed: exact instant. All-day: local midnight of the first day.
     * end_at is EXCLUSIVE (all-day: local midnight after the last day).
     */
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    recurrence: jsonb("recurrence").$type<Recurrence>(),
    /** Start of the last possible occurrence; null = forever. Used to prune queries. */
    recurrenceEndAt: timestamp("recurrence_end_at", { withTimezone: true }),
    /** Cancelled occurrences, as occurrence start ISO strings. */
    exdates: jsonb("exdates").$type<string[]>().notNull().default([]),
    /** Minutes before start to remind; null = no reminder. Ignored for all-day. */
    reminderMinutes: integer("reminder_minutes"),
    /** WhatsApp message that created it; makes inbox retries idempotent. */
    sourceMessageId: text("source_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_start_idx").on(t.startAt),
    index("events_end_idx").on(t.endAt),
    index("events_source_msg_idx").on(t.sourceMessageId),
  ],
);

export const reminderLog = pgTable(
  "reminder_log",
  {
    /** Store event id (iCloud object URL or Postgres uuid). */
    eventId: text("event_id").notNull(),
    occurrenceStart: timestamp("occurrence_start", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.occurrenceStart] })],
);

export const digestLog = pgTable(
  "digest_log",
  {
    kind: text("kind").$type<"morning" | "evening">().notNull(),
    localDate: date("local_date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.localDate] })],
);

/**
 * Durable inbox. The webhook only inserts here (deduped on Z-API messageId)
 * and wakes the Scheduler DO, which processes rows in order with retries:
 *   pending → (LLM ran, reply stored) answered → (WhatsApp sent) done
 *   any step failing MAX_ATTEMPTS times → failed (user is told explicitly)
 * Storing the reply before sending means a send retry never re-runs the LLM.
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    messageId: text("message_id").primaryKey(),
    phone: text("phone").notNull().default(""),
    text: text("text").notNull().default(""),
    status: text("status")
      .$type<"pending" | "answered" | "done" | "failed">()
      .notNull()
      .default("done"),
    attempts: integer("attempts").notNull().default(0),
    reply: text("reply"),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("inbound_status_idx").on(t.status, t.receivedAt)],
);

/**
 * Events created while handling a WhatsApp message. Lets the failure notice
 * say exactly what got saved before something broke.
 */
export const messageEvents = pgTable(
  "message_events",
  {
    messageId: text("message_id").notNull(),
    eventId: text("event_id").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.eventId] })],
);

export type Category = typeof categories.$inferSelect;
export type EventRow = typeof events.$inferSelect;

/**
 * Structured conversation state (single row, id=1). NOT a chat transcript:
 * the model never sees past replies, only these code-built facts.
 * - draft: an incomplete create waiting for missing fields (e.g. the date)
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
/** "Qual deles?" was asked: the user must pick one focus item for this action. */
export type PendingPick =
  | { action: "delete"; only_that_day?: boolean | null }
  | { action: "update"; changes: Record<string, unknown> };

export const assistantState = pgTable("assistant_state", {
  id: integer("id").primaryKey().default(1),
  draft: jsonb("draft").$type<DraftCreate | null>(),
  draftAt: timestamp("draft_at", { withTimezone: true }),
  pick: jsonb("pick").$type<PendingPick | null>(),
  focus: jsonb("focus").$type<FocusItem[]>().notNull().default([]),
  focusAt: timestamp("focus_at", { withTimezone: true }),
});
