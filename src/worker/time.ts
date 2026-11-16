/**
 * Timezone helpers. Workers run in UTC; everything user-facing is in the
 * configured IANA zone. Plain dates are "YYYY-MM-DD" strings, local
 * date-times are "YYYY-MM-DDTHH:mm" (no offset).
 */

export type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function toLocalParts(date: Date, tz: string): LocalParts & { second: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

/** Offset (ms) such that local wall time = utc + offset. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = toLocalParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in `tz` → UTC instant. */
export function localToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(local);
  if (!m) throw new Error(`Invalid local date/time: ${local}`);
  const [, y, mo, d, h = "0", mi = "0"] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi);
  // Two passes handle DST edges.
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

export function localDate(date: Date, tz: string): string {
  const p = toLocalParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTime(date: Date, tz: string): string {
  const p = toLocalParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function localDateTime(date: Date, tz: string): string {
  return `${localDate(date, tz)}T${localTime(date, tz)}`;
}

/** Plain-date arithmetic, timezone-free. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const WEEKDAY_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const MONTH_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export function weekdayNamePt(ymd: string): string {
  return WEEKDAY_PT[weekdayOf(ymd)]!;
}

/** "segunda, 16 de novembro" */
export function humanDatePt(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${weekdayNamePt(ymd)}, ${d} de ${MONTH_PT[m! - 1]}`;
}

/** "16/11" */
export function shortDatePt(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${d}/${m}`;
}

/** "07:00" → minutes since midnight */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
