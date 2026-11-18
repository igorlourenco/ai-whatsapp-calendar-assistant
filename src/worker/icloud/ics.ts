import ICAL from "ical.js";

import type { Recurrence } from "../db/schema";
import { localToUtc, toLocalParts } from "../time";

/** One concrete occurrence of a calendar object, normalized. */
export type ParsedOccurrence = {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  recurring: boolean;
  /** Minutes before start of the first display/audio alarm; null = no alert. */
  reminderMinutes: number | null;
};

const MAX_ITER = 5000;

function registerTimezones(root: ICAL.Component) {
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    const tzid = vtz.getFirstPropertyValue("tzid");
    if (typeof tzid === "string" && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    }
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ICAL.Time → instant. Dates and floating times are read in `tz`. */
function toDate(t: ICAL.Time, tz: string): Date {
  const ymd = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  if (t.isDate) return localToUtc(ymd, tz);
  const zone = t.zone?.tzid;
  if (!zone || zone === "floating") return localToUtc(`${ymd}T${pad(t.hour)}:${pad(t.minute)}`, tz);
  return new Date(t.toUnixTime() * 1000);
}

function firstAlarmMinutes(vevent: ICAL.Component): number | null {
  for (const alarm of vevent.getAllSubcomponents("valarm")) {
    const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
    if (action !== "DISPLAY" && action !== "AUDIO") continue;
    const trigger = alarm.getFirstPropertyValue("trigger");
    if (trigger instanceof ICAL.Duration) {
      const secs = trigger.toSeconds();
      if (secs <= 0) return Math.round(-secs / 60);
    }
  }
  return null;
}

function text(v: ICAL.Component, name: string): string | null {
  const val = v.getFirstPropertyValue(name);
  return typeof val === "string" && val.trim() ? val : null;
}

/** Expand a VCALENDAR object into occurrences overlapping [from, to). */
export function parseOccurrences(ics: string, from: Date, to: Date, tz: string): ParsedOccurrence[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(root);
  const vevents = root.getAllSubcomponents("vevent");
  const master = vevents.find((v) => !v.hasProperty("recurrence-id")) ?? vevents[0];
  if (!master) return [];

  const event = new ICAL.Event(master);
  for (const ex of vevents) if (ex !== master && ex.hasProperty("recurrence-id")) event.relateException(ex);

  const base = {
    uid: event.uid,
    recurring: event.isRecurring(),
  };
  const make = (item: ICAL.Event, s: ICAL.Time, e: ICAL.Time): ParsedOccurrence => {
    const allDay = s.isDate;
    const start = toDate(s, tz);
    let end = toDate(e, tz);
    if (end <= start) end = new Date(start.getTime() + (allDay ? 86_400_000 : 0));
    return {
      ...base,
      title: item.summary || "(sem título)",
      start,
      end,
      allDay,
      location: text(item.component, "location"),
      notes: text(item.component, "description"),
      reminderMinutes: allDay ? null : firstAlarmMinutes(item.component),
    };
  };

  if (!event.isRecurring()) {
    const o = make(event, event.startDate, event.endDate ?? event.startDate);
    return o.start < to && o.end > from ? [o] : [];
  }

  const out: ParsedOccurrence[] = [];
  const it = event.iterator();
  for (let i = 0; i < MAX_ITER; i++) {
    const next = it.next();
    if (!next) break;
    const d = event.getOccurrenceDetails(next);
    const o = make(d.item, d.startDate, d.endDate);
    if (toDate(next, tz) >= to && o.start >= to) break;
    if (o.start < to && o.end > from) out.push(o);
  }
  return out;
}

/* -------------------------------- writing ------------------------------- */

export type NewEvent = {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** For all-day: local dates, first and last-exclusive ("YYYY-MM-DD"). */
  startDate?: string;
  endDateExclusive?: string;
  location?: string | null;
  notes?: string | null;
  recurrence?: Recurrence | null;
  reminderMinutes?: number | null;
};

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function escapeText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Floating local wall-clock time ("20261116T190000", no Z / TZID). */
function localStamp(d: Date, tz: string): string {
  const p = toLocalParts(d, tz);
  return `${p.year}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}00`;
}
const dateValue = (ymd: string) => ymd.replace(/-/g, "");

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (curLen + len > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** UNTIL must match DTSTART's form: DATE for all-day, floating local time for timed. */
export function rruleOf(r: Recurrence, allDay: boolean): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byWeekday?.length) parts.push(`BYDAY=${r.byWeekday.map((d) => BYDAY[d]).join(",")}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  else if (r.until) {
    // UNTIL is inclusive; end of that local day.
    parts.push(allDay ? `UNTIL=${dateValue(r.until)}` : `UNTIL=${dateValue(r.until)}T235959`);
  }
  return `RRULE:${parts.join(";")}`;
}

/** VEVENT lines of one event (see buildIcs for the time encoding). */
function veventLines(ev: NewEvent, tz: string, now: Date, extra: string[] = []): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `CREATED:${utcStamp(now)}`,
    `LAST-MODIFIED:${utcStamp(now)}`,
    `SUMMARY:${escapeText(ev.title)}`,
    ...(ev.allDay
      ? [`DTSTART;VALUE=DATE:${dateValue(ev.startDate!)}`, `DTEND;VALUE=DATE:${dateValue(ev.endDateExclusive!)}`]
      : ev.recurrence
        ? [`DTSTART:${localStamp(ev.start, tz)}`, `DTEND:${localStamp(ev.end, tz)}`]
        : [`DTSTART:${utcStamp(ev.start)}`, `DTEND:${utcStamp(ev.end)}`]),
    ...(ev.recurrence ? [rruleOf(ev.recurrence, ev.allDay)] : []),
    ...extra,
    ...(ev.location ? [`LOCATION:${escapeText(ev.location)}`] : []),
    ...(ev.notes ? [`DESCRIPTION:${escapeText(ev.notes)}`] : []),
    ...(!ev.allDay && ev.reminderMinutes != null
      ? [
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          `DESCRIPTION:${escapeText(ev.title)}`,
          `TRIGGER:-PT${ev.reminderMinutes}M`,
          `UID:${ev.uid}-alarm`,
          "END:VALARM",
        ]
      : []),
    "END:VEVENT",
  ];
}

const HEADER = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ai-assistant-wpp//PT-BR", "CALSCALE:GREGORIAN"];

/**
 * Serialize a new event. One-off timed events are written in UTC (an exact
 * instant). Recurring timed events are written in floating local time, so the
 * RRULE expands on wall-clock time: a weekly 19:00 class stays at 19:00 across
 * DST changes in any timezone.
 */
export function buildIcs(ev: NewEvent, tz: string, now = new Date()): string {
  return [...HEADER, ...veventLines(ev, tz, now), "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}

export type FeedEvent = NewEvent & { exdates?: string[]; category?: string | null };

/**
 * Whole calendar as one subscribable feed (webcal://…/cal/<token>.ics).
 * Read-only on the phone; refreshed by the calendar app every ~15 min.
 */
export function buildFeed(name: string, list: FeedEvent[], tz: string, now = new Date()): string {
  const lines = [
    ...HEADER,
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${tz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];
  for (const ev of list) {
    // EXDATE must match DTSTART's form (DATE / floating local / UTC).
    const ex = (ev.exdates ?? []).map((iso) => {
      const d = new Date(iso);
      if (ev.allDay) return `EXDATE;VALUE=DATE:${dateValue(localDateOf(d, tz))}`;
      return `EXDATE:${ev.recurrence ? localStamp(d, tz) : utcStamp(d)}`;
    });
    const cat = ev.category ? [`CATEGORIES:${escapeText(ev.category)}`] : [];
    lines.push(...veventLines(ev, tz, now, [...ex, ...cat]));
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function localDateOf(d: Date, tz: string): string {
  const p = toLocalParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/* ------------------------- editing existing objects ---------------------- */

export type EventPatch = {
  title?: string;
  start?: Date;
  end?: Date;
  allDay?: boolean;
  startDate?: string;
  endDateExclusive?: string;
  location?: string | null;
  notes?: string | null;
  /** undefined = keep, null = remove alerts, n = single alert n min before. */
  reminderMinutes?: number | null;
};

function setTime(v: ICAL.Component, name: "dtstart" | "dtend", value: ICAL.Time) {
  v.removeAllProperties(name);
  const p = new ICAL.Property(name);
  if (value.isDate) p.resetType("date");
  p.setValue(value);
  v.addProperty(p);
}

const icalUtc = (d: Date) => ICAL.Time.fromJSDate(d, true);
const icalDate = (ymd: string) => ICAL.Time.fromDateString(ymd);

/**
 * Edit the master VEVENT of an existing object (made by us or on the
 * iPhone), keeping every property we don't touch (attendees, URL, Apple
 * extensions, other alarms when reminder is unchanged…).
 */
/**
 * Timed value for DTSTART/DTEND. Recurring events keep wall-clock semantics:
 * the existing TZID (iPhone-made events) when known, else floating time.
 */
function timedValue(master: ICAL.Component, d: Date, tz: string): { time: ICAL.Time; tzid?: string } {
  if (!master.hasProperty("rrule")) return { time: icalUtc(d) };
  const p = toLocalParts(d, tz);
  const data = { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: 0, isDate: false };
  const tzid = master.getFirstProperty("dtstart")?.getParameter("tzid");
  if (typeof tzid === "string" && ICAL.TimezoneService.has(tzid)) {
    return { time: ICAL.Time.fromData(data, ICAL.TimezoneService.get(tzid)), tzid };
  }
  return { time: ICAL.Time.fromData(data) };
}

export function patchIcs(ics: string, patch: EventPatch, tz: string): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(root);
  const v = root.getAllSubcomponents("vevent").find((x) => !x.hasProperty("recurrence-id"));
  if (!v) throw new Error("no master VEVENT");

  if (patch.title !== undefined) v.updatePropertyWithValue("summary", patch.title);
  if (patch.location !== undefined) {
    v.removeAllProperties("location");
    if (patch.location) v.addPropertyWithValue("location", patch.location);
  }
  if (patch.notes !== undefined) {
    v.removeAllProperties("description");
    if (patch.notes) v.addPropertyWithValue("description", patch.notes);
  }
  if (patch.allDay !== undefined || patch.start || patch.startDate) {
    if (patch.allDay) {
      setTime(v, "dtstart", icalDate(patch.startDate!));
      setTime(v, "dtend", icalDate(patch.endDateExclusive!));
    } else {
      for (const [name, d] of [["dtstart", patch.start!], ["dtend", patch.end!]] as const) {
        const { time, tzid } = timedValue(v, d, tz);
        setTime(v, name, time);
        if (tzid) v.getFirstProperty(name)!.setParameter("tzid", tzid);
      }
    }
    v.removeAllProperties("duration");
  }
  if (patch.reminderMinutes !== undefined) {
    for (const a of v.getAllSubcomponents("valarm")) v.removeSubcomponent(a);
    if (patch.reminderMinutes !== null) {
      const alarm = new ICAL.Component("valarm");
      alarm.addPropertyWithValue("action", "DISPLAY");
      alarm.addPropertyWithValue("description", String(v.getFirstPropertyValue("summary") ?? "Lembrete"));
      alarm.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(-patch.reminderMinutes * 60));
      v.addSubcomponent(alarm);
    }
  }
  const now = icalUtc(new Date());
  v.updatePropertyWithValue("dtstamp", now);
  v.updatePropertyWithValue("last-modified", now);
  const seq = Number(v.getFirstPropertyValue("sequence") ?? 0);
  v.updatePropertyWithValue("sequence", seq + 1);
  return root.toString();
}

/** Cancel one occurrence of a recurring object (EXDATE + drop its override, if any). */
export function excludeOccurrence(ics: string, occurrenceStart: Date, tz: string): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(root);
  const vevents = root.getAllSubcomponents("vevent");
  const master = vevents.find((x) => !x.hasProperty("recurrence-id"));
  if (!master) throw new Error("no master VEVENT");
  const event = new ICAL.Event(master);

  // Find the occurrence's own ICAL.Time so EXDATE matches DTSTART's type/zone.
  const it = event.iterator();
  let match: ICAL.Time | null = null;
  for (let i = 0; i < MAX_ITER; i++) {
    const t = it.next();
    if (!t) break;
    const ms = toDate(t, tz).getTime();
    if (ms === occurrenceStart.getTime()) {
      match = t;
      break;
    }
    if (ms > occurrenceStart.getTime()) break;
  }
  if (!match) throw new Error("occurrence not found");

  const p = new ICAL.Property("exdate");
  if (match.isDate) p.resetType("date");
  p.setValue(match);
  const tzid = match.zone?.tzid;
  if (!match.isDate && tzid && tzid !== "UTC" && tzid !== "floating") p.setParameter("tzid", tzid);
  master.addProperty(p);

  for (const ex of vevents) {
    if (ex === master) continue;
    const rid = ex.getFirstPropertyValue("recurrence-id");
    if (rid instanceof ICAL.Time && toDate(rid, tz).getTime() === occurrenceStart.getTime()) root.removeSubcomponent(ex);
  }
  return root.toString();
}

/* ----------------------------- master summary ---------------------------- */

export type ParsedMaster = {
  uid: string;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  recurrence: Recurrence | null;
  reminderMinutes: number | null;
};

const FREQS = new Set(["daily", "weekly", "monthly", "yearly"]);

/** Apple RRULE → our Recurrence (display/truthiness; expansion always uses ical.js). */
function toRecurrence(recur: ICAL.Recur, tz: string): Recurrence {
  const freq = String(recur.freq).toLowerCase();
  const byday = (recur.parts?.BYDAY ?? []) as string[];
  const byWeekday = byday
    .map((d) => BYDAY.indexOf(String(d).replace(/^[+-]?\d+/, "")))
    .filter((d) => d >= 0);
  const until = recur.until ? toDate(recur.until, tz) : null;
  return {
    freq: (FREQS.has(freq) ? freq : "daily") as Recurrence["freq"],
    ...(recur.interval && recur.interval > 1 ? { interval: recur.interval } : {}),
    ...(freq === "weekly" && byWeekday.length ? { byWeekday } : {}),
    ...(until ? { until: new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(until) } : {}),
    ...(recur.count ? { count: recur.count } : {}),
  };
}

export function parseMaster(ics: string, tz: string): ParsedMaster | null {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(root);
  const vevents = root.getAllSubcomponents("vevent");
  const master = vevents.find((v) => !v.hasProperty("recurrence-id")) ?? vevents[0];
  if (!master) return null;
  const ev = new ICAL.Event(master);
  const s = ev.startDate;
  const allDay = s.isDate;
  const startAt = toDate(s, tz);
  let endAt = ev.endDate ? toDate(ev.endDate, tz) : startAt;
  if (endAt <= startAt) endAt = new Date(startAt.getTime() + (allDay ? 86_400_000 : 0));
  const rrule = master.getFirstPropertyValue("rrule");
  return {
    uid: ev.uid,
    title: ev.summary || "(sem título)",
    startAt,
    endAt,
    allDay,
    location: text(master, "location"),
    notes: text(master, "description"),
    recurrence: rrule instanceof ICAL.Recur ? toRecurrence(rrule, tz) : null,
    reminderMinutes: allDay ? null : firstAlarmMinutes(master),
  };
}

/** Same object with a new UID on every VEVENT (moving between iCloud calendars needs a fresh UID). */
export function withUid(ics: string, uid: string): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const v of root.getAllSubcomponents("vevent")) {
    v.updatePropertyWithValue("uid", uid);
    for (const a of v.getAllSubcomponents("valarm")) a.removeAllProperties("uid");
  }
  return root.toString();
}
