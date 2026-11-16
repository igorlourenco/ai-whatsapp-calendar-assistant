import { eq } from "drizzle-orm";

import type { OccurrenceView } from "../calendar/store";
import type { Db } from "../db/client";
import { assistantState, type DraftCreate, type FocusItem, type PendingPick } from "../db/schema";
import { localDate, localTime, shortDatePt, weekdayNamePt } from "../time";

const DRAFT_TTL_MS = 15 * 60_000;
const FOCUS_TTL_MS = 30 * 60_000;
const FOCUS_MAX = 10;

/** draft and pick are "pending questions": they live only until the next message. */
export type State = { draft: DraftCreate | null; focus: FocusItem[]; pick?: PendingPick | null };

export async function loadState(db: Db, now = new Date()): Promise<State> {
  const [row] = await db.select().from(assistantState).where(eq(assistantState.id, 1)).limit(1);
  if (!row) return { draft: null, focus: [], pick: null };
  const fresh = (at: Date | null, ttl: number) => !!at && now.getTime() - at.getTime() < ttl;
  return {
    draft: fresh(row.draftAt, DRAFT_TTL_MS) ? row.draft : null,
    pick: fresh(row.draftAt, DRAFT_TTL_MS) ? row.pick : null,
    focus: fresh(row.focusAt, FOCUS_TTL_MS) ? row.focus : [],
  };
}

export async function saveState(db: Db, s: State, now = new Date()): Promise<void> {
  const values = {
    id: 1,
    draft: s.draft,
    pick: s.pick ?? null,
    draftAt: s.draft || s.pick ? now : null,
    focus: s.focus.slice(0, FOCUS_MAX),
    focusAt: s.focus.length ? now : null,
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

/** Put items at the front (most recent = E1), dedupe by event. */
export function pushFocus(focus: FocusItem[], items: FocusItem[]): FocusItem[] {
  const ids = new Set(items.map((i) => i.eventId));
  return [...items, ...focus.filter((f) => !ids.has(f.eventId))].slice(0, FOCUS_MAX);
}
