import type { Recurrence } from "../db/schema";
import { addDays, diffDays, localDate, localTime, localToUtc, weekdayOf } from "../time";

export type EventLike = {
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  recurrence: Recurrence | null;
  exdates: string[];
};

export type Occurrence = { start: Date; end: Date };

const MAX_ITER = 20_000;

/**
 * Expand an event into the occurrences overlapping [from, to).
 * Recurrence runs on local wall-clock time so a weekly 10:00 class stays at
 * 10:00 regardless of DST.
 */
export function expandOccurrences(ev: EventLike, from: Date, to: Date, tz: string): Occurrence[] {
  const duration = ev.endAt.getTime() - ev.startAt.getTime();
  const overlaps = (s: Date) => s < to && s.getTime() + duration > from.getTime();

  if (!ev.recurrence) {
    return overlaps(ev.startAt) ? [{ start: ev.startAt, end: ev.endAt }] : [];
  }

  const r = ev.recurrence;
  const interval = Math.max(1, r.interval ?? 1);
  const startDate = localDate(ev.startAt, tz);
  const time = ev.allDay ? "00:00" : localTime(ev.startAt, tz);
  const exdates = new Set(ev.exdates.map((d) => new Date(d).getTime()));
  const out: Occurrence[] = [];
  let produced = 0;

  const emit = (ymd: string): "stop" | "continue" => {
    if (r.until && ymd > r.until) return "stop";
    if (r.count && produced >= r.count) return "stop";
    const start = localToUtc(`${ymd}T${time}`, tz);
    if (start >= to) return "stop";
    produced++;
    if (!exdates.has(start.getTime()) && overlaps(start)) {
      out.push({ start, end: new Date(start.getTime() + duration) });
    }
    return "continue";
  };

  for (const ymd of candidateDates(startDate, r, interval)) {
    if (emit(ymd) === "stop") break;
  }
  return out;
}

function* candidateDates(startDate: string, r: Recurrence, interval: number): Generator<string> {
  const [sy, sm, sd] = startDate.split("-").map(Number) as [number, number, number];
  for (let k = 0; k < MAX_ITER; k++) {
    switch (r.freq) {
      case "daily":
        yield addDays(startDate, k * interval);
        break;
      case "weekly": {
        const days = (r.byWeekday?.length ? [...r.byWeekday] : [weekdayOf(startDate)]).sort();
        const weekStart = addDays(startDate, -weekdayOf(startDate) + k * 7 * interval);
        for (const wd of days) {
          const ymd = addDays(weekStart, wd);
          if (diffDays(startDate, ymd) >= 0) yield ymd;
        }
        break;
      }
      case "monthly": {
        const total = sm - 1 + k * interval;
        const y = sy + Math.floor(total / 12);
        const m = (total % 12) + 1;
        if (sd <= daysInMonth(y, m)) yield ymdOf(y, m, sd);
        break;
      }
      case "yearly": {
        const y = sy + k * interval;
        if (sd <= daysInMonth(y, sm)) yield ymdOf(y, sm, sd);
        break;
      }
    }
  }
}

function daysInMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ymdOf(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Start of the last occurrence, or null if unbounded. */
export function recurrenceEnd(ev: EventLike, tz: string): Date | null {
  const r = ev.recurrence;
  if (!r) return ev.startAt;
  if (!r.until && !r.count) return null;
  const horizon = r.until
    ? localToUtc(addDays(r.until, 1), tz)
    : new Date(ev.startAt.getTime() + 400 * 366 * 86_400_000);
  const occ = expandOccurrences({ ...ev, exdates: [] }, ev.startAt, horizon, tz);
  return occ.at(-1)?.start ?? ev.startAt;
}
