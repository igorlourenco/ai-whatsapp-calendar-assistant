import type { Recurrence } from "../db/schema";
import { addDays, localToUtc } from "../time";

/*
 * Storage boundary. Production: iCloud (CalDAV). Tests/eval: Postgres.
 * Everything above this layer (executor, digests, reminders) only sees these
 * types, so it behaves identically on both.
 */

export type StoreCategory = {
  id: string;
  slug: string;
  name: string;
  emoji: string;
  color: string;
};

export type StoreEvent = {
  /** Opaque id: iCloud object URL, or Postgres uuid. */
  id: string;
  title: string;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  recurrence: Recurrence | null;
  reminderMinutes: number | null;
  /** First occurrence (master DTSTART/DTEND). end is exclusive. */
  startAt: Date;
  endAt: Date;
};

export type OccurrenceView = {
  event: StoreEvent;
  category: StoreCategory | null;
  start: Date;
  end: Date;
};

export type EventInput = {
  title: string;
  /** All-day: "YYYY-MM-DD". Timed: "YYYY-MM-DDTHH:mm" (local). */
  start: string;
  /** All-day: last day INCLUSIVE ("YYYY-MM-DD"). Timed: local end date-time. */
  end?: string | null;
  allDay: boolean;
  category?: string | null;
  location?: string | null;
  notes?: string | null;
  recurrence?: Recurrence | null;
  reminderMinutes?: number | null;
  /** Originating WhatsApp message; a retry of the same message won't duplicate. */
  sourceMessageId?: string | null;
};

export interface CalendarStore {
  listCategories(): Promise<StoreCategory[]>;
  findCategory(nameOrSlug: string): Promise<StoreCategory | null>;
  createCategory(input: { name: string; emoji: string; color?: string }): Promise<StoreCategory>;

  /** Occurrences overlapping [from, to), sorted (all-day first per instant). */
  findOccurrences(
    from: Date,
    to: Date,
    opts?: { category?: string | null; query?: string | null },
  ): Promise<OccurrenceView[]>;
  getEvent(id: string): Promise<(StoreEvent & { category: StoreCategory | null }) | null>;
  createEvent(input: EventInput): Promise<StoreEvent>;
  updateEvent(id: string, patch: Partial<EventInput>): Promise<StoreEvent | null>;
  /** Pass occurrenceStart to cancel just that occurrence of a recurring event. */
  deleteEvent(id: string, occurrenceStart?: Date | null): Promise<"deleted" | "occurrence_cancelled" | "not_found">;
}

/** Invalid request from the user (bad dates etc.). Shown to them; not retried. */
export class UserError extends Error {}

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Local input → instants. end is exclusive (all-day: midnight after last day). */
export function resolveTimes(tz: string, input: Pick<EventInput, "start" | "end" | "allDay">) {
  if (input.allDay) {
    const startDay = input.start.slice(0, 10);
    const lastDay = (input.end ?? startDay).slice(0, 10);
    if (lastDay < startDay) throw new UserError("A data final ficou antes da inicial.");
    const endDay = addDays(lastDay, 1);
    return { startAt: localToUtc(startDay, tz), endAt: localToUtc(endDay, tz), startDay, endDay };
  }
  if (!/T\d{2}:\d{2}/.test(input.start)) throw new UserError("Faltou o horário de início.");
  const startAt = localToUtc(input.start, tz);
  const endAt = input.end
    ? localToUtc(/T\d{2}:\d{2}/.test(input.end) ? input.end : `${input.end}T23:59`, tz)
    : new Date(startAt.getTime() + 60 * 60_000);
  if (endAt <= startAt) throw new UserError("O horário final ficou antes do inicial.");
  return { startAt, endAt, startDay: input.start.slice(0, 10), endDay: null };
}

export const sortOccurrences = (a: OccurrenceView, b: OccurrenceView) =>
  a.start.getTime() - b.start.getTime() ||
  Number(b.event.allDay) - Number(a.event.allDay) ||
  a.event.title.localeCompare(b.event.title);

export const normText = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
