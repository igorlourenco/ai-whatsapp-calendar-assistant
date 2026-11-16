import { addDays, diffDays, humanDatePt, localDate, localTime, localToUtc } from "../time";
import type { OccurrenceView } from "./store";

const DEFAULT_EMOJI = "📌";

/** One WhatsApp line for an occurrence, as seen on `day`. */
export function formatLine(o: OccurrenceView, day: string, tz: string): string {
  const emoji = o.category?.emoji ?? DEFAULT_EMOJI;
  const startDay = localDate(o.start, tz);
  const lastDay = localDate(new Date(o.end.getTime() - 1), tz);
  const multi = startDay !== lastDay;
  const span = multi ? ` _(dia ${diffDays(startDay, day) + 1}/${diffDays(startDay, lastDay) + 1})_` : "";

  let when: string;
  if (o.event.allDay) when = "Dia todo";
  else if (!multi) when = `${localTime(o.start, tz)}–${localTime(o.end, tz)}`;
  else if (day === startDay) when = `a partir das ${localTime(o.start, tz)}`;
  else if (day === lastDay) when = `até ${localTime(o.end, tz)}`;
  else when = "Dia todo";

  const loc = o.event.location ? ` · 📍 ${o.event.location}` : "";
  return `${emoji} *${when}* ${o.event.title}${span}${loc}`;
}

/** Group occurrences by local day in [fromDay, toDay] (inclusive). */
export function formatAgenda(
  occ: OccurrenceView[],
  fromDay: string,
  toDay: string,
  tz: string,
  opts: { emptyText?: string; skipEmptyDays?: boolean } = {},
): string {
  const blocks: string[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    const dayStart = localToUtc(day, tz);
    const dayEnd = localToUtc(addDays(day, 1), tz);
    const items = occ.filter((o) => o.start < dayEnd && o.end > dayStart);
    if (!items.length && (opts.skipEmptyDays ?? fromDay !== toDay)) continue;
    const header = `🗓️ *${capitalize(humanDatePt(day))}*`;
    const body = items.length ? items.map((o) => formatLine(o, day, tz)).join("\n") : "Nada marcado ✨";
    blocks.push(`${header}\n${body}`);
  }
  return blocks.length ? blocks.join("\n\n") : (opts.emptyText ?? "Nada marcado nesse período ✨");
}

export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
