import { eq } from "drizzle-orm";

import type { OccurrenceView } from "../calendar/store";
import type { Db } from "../db/client";
import { assistantState, type DraftCreate, type ExpenseRef, type FocusItem, type PendingBatch, type PendingPick, type TaskRef } from "../db/schema";
import { localDate, localTime, shortDatePt, weekdayNamePt } from "../time";

const DRAFT_TTL_MS = 15 * 60_000;
const FOCUS_TTL_MS = 30 * 60_000;
const FOCUS_MAX = 10;
/** Events read from an image wait this long for "sim / não / 1,3". */
const BATCH_TTL_MS = 24 * 60 * 60_000;

/**
 * draft and pick are "pending questions": they live only until the next
 * message. batch (events read from an image) survives unrelated messages
 * until it is answered, replaced by another image, or expires.
 */
export type State = {
  draft: DraftCreate | null;
  focus: FocusItem[];
  pick?: PendingPick | null;
  batch?: PendingBatch | null;
  /** Tasks recently created/changed/listed (T1…). */
  tasks?: TaskRef[];
  /** Expenses recently logged/changed/listed (G1…). */
  expenses?: ExpenseRef[];
  /** Which numbered list was shown last ("o 2" → E2, T2 or G2). */
  lastList?: "events" | "tasks" | "expenses" | null;
};

export async function loadState(db: Db, now = new Date()): Promise<State> {
  const [row] = await db.select().from(assistantState).where(eq(assistantState.id, 1)).limit(1);
  if (!row) return { draft: null, focus: [], pick: null, batch: null, tasks: [], expenses: [], lastList: null };
  const fresh = (at: Date | null, ttl: number) => !!at && now.getTime() - at.getTime() < ttl;
  return {
    draft: fresh(row.draftAt, DRAFT_TTL_MS) ? row.draft : null,
    pick: fresh(row.draftAt, DRAFT_TTL_MS) ? row.pick : null,
    focus: fresh(row.focusAt, FOCUS_TTL_MS) ? row.focus : [],
    batch: fresh(row.batchAt, BATCH_TTL_MS) ? row.batch : null,
    tasks: fresh(row.taskFocusAt, FOCUS_TTL_MS) ? row.taskFocus : [],
    expenses: fresh(row.expenseFocusAt, FOCUS_TTL_MS) ? row.expenseFocus : [],
    lastList:
      fresh(row.focusAt, FOCUS_TTL_MS) || fresh(row.taskFocusAt, FOCUS_TTL_MS) || fresh(row.expenseFocusAt, FOCUS_TTL_MS) ? row.lastList : null,
  };
}

export async function saveState(db: Db, s: State, now = new Date()): Promise<void> {
  const values = {
    batch: s.batch ?? null,
    // TTL counts from when the image arrived, never extended by later saves.
    batchAt: s.batch ? new Date(s.batch.createdAt) : null,
    id: 1,
    draft: s.draft,
    pick: s.pick ?? null,
    draftAt: s.draft || s.pick ? now : null,
    focus: s.focus.slice(0, FOCUS_MAX),
    focusAt: s.focus.length ? now : null,
    taskFocus: (s.tasks ?? []).slice(0, FOCUS_MAX),
    taskFocusAt: s.tasks?.length ? now : null,
    expenseFocus: (s.expenses ?? []).slice(0, FOCUS_MAX),
    expenseFocusAt: s.expenses?.length ? now : null,
    lastList: s.lastList ?? null,
  };
  await db.insert(assistantState).values(values).onConflictDoUpdate({ target: assistantState.id, set: values });
}

/** "Dentista — sexta 20/11 15:00" (code-built; this is what the model sees as E1…). */
export function focusLabel(o: OccurrenceView, tz: string): string {
  const day = localDate(o.start, tz);
  const when = `${weekdayNamePt(day)} ${shortDatePt(day)}${o.event.allDay ? " (dia todo)" : ` ${localTime(o.start, tz)}`}`;
  return `${o.event.title} — ${when}${o.event.recurrence ? " (repete)" : ""}`;
}

export function toFocus(o: OccurrenceView, tz: string): FocusItem {
  return { eventId: o.event.id, occurrenceStart: o.start.toISOString(), label: focusLabel(o, tz) };
}

/** Put tasks at the front (most recent = T1), dedupe. */
export function pushTasks(list: TaskRef[], items: TaskRef[]): TaskRef[] {
  const ids = new Set(items.map((i) => i.taskId));
  return [...items, ...list.filter((t) => !ids.has(t.taskId))].slice(0, FOCUS_MAX);
}

/** Put expenses at the front (most recent = G1), dedupe. */
export function pushExpenses(list: ExpenseRef[], items: ExpenseRef[]): ExpenseRef[] {
  const ids = new Set(items.map((i) => i.expenseId));
  return [...items, ...list.filter((e) => !ids.has(e.expenseId))].slice(0, FOCUS_MAX);
}

/** Put items at the front (most recent = E1), dedupe by event. */
export function pushFocus(focus: FocusItem[], items: FocusItem[]): FocusItem[] {
  const ids = new Set(items.map((i) => i.eventId));
  return [...items, ...focus.filter((f) => !ids.has(f.eventId))].slice(0, FOCUS_MAX);
}
