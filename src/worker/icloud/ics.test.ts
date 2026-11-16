import { describe, expect, it } from "vitest";

import { localDateTime, localToUtc } from "../time";
import { buildIcs, excludeOccurrence, parseMaster, parseOccurrences, patchIcs } from "./ics";

const TZ = "America/Araguaina";
const L = (s: string) => localToUtc(s, TZ);
const range = (a: string, b: string) => [L(a), L(b)] as const;

/** Shaped like what the iPhone writes: TZID + VTIMEZONE, Apple props, default alarm. */
const APPLE_WEEKLY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iPhone OS 26.1//EN
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:America/Araguaina
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:-0300
TZOFFSETTO:-0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:APPLE-1
DTSTAMP:20261101T120000Z
SUMMARY:Aula de Civil
LOCATION:Bloco B
DTSTART;TZID=America/Araguaina:20261116T190000
DTEND;TZID=America/Araguaina:20261116T220000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261216T220000Z
EXDATE;TZID=America/Araguaina:20261118T190000
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Reminder
TRIGGER:-PT15M
X-APPLE-DEFAULT-ALARM:TRUE
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:APPLE-1
DTSTAMP:20261101T120000Z
RECURRENCE-ID;TZID=America/Araguaina:20261123T190000
SUMMARY:Aula de Civil (sala 12)
DTSTART;TZID=America/Araguaina:20261123T200000
DTEND;TZID=America/Araguaina:20261123T220000
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, "\r\n");

describe("parse Apple events", () => {
  it("expands weekly TZID recurrence with EXDATE and an overridden instance", () => {
    const occ = parseOccurrences(APPLE_WEEKLY, ...range("2026-11-16", "2026-12-01"), TZ);
    expect(occ.map((o) => `${localDateTime(o.start, TZ)} ${o.title}`)).toEqual([
      "2026-11-16T19:00 Aula de Civil",
      "2026-11-23T20:00 Aula de Civil (sala 12)",
      "2026-11-25T19:00 Aula de Civil",
      "2026-11-30T19:00 Aula de Civil",
    ]);
    expect(occ[0]).toMatchObject({ location: "Bloco B", reminderMinutes: 15, recurring: true, allDay: false });
  });

  it("master summary converts RRULE", () => {
    const m = parseMaster(APPLE_WEEKLY, TZ)!;
    expect(m.recurrence).toEqual({ freq: "weekly", byWeekday: [1, 3], until: "2026-12-16" });
    expect(localDateTime(m.startAt, TZ)).toBe("2026-11-16T19:00");
  });

  it("all-day multi-day (DATE values, DTEND exclusive)", () => {
    const ics = buildIcs(
      { uid: "X", title: "Viagem", start: L("2026-12-20"), end: L("2026-12-24"), allDay: true, startDate: "2026-12-20", endDateExclusive: "2026-12-24" },
      TZ,
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261220");
    expect(ics).toContain("DTEND;VALUE=DATE:20261224");
    expect(parseOccurrences(ics, ...range("2026-12-23", "2026-12-24"), TZ)).toHaveLength(1);
    expect(parseOccurrences(ics, ...range("2026-12-24", "2026-12-25"), TZ)).toHaveLength(0);
  });
});

describe("write", () => {
  const ours = buildIcs(
    {
      uid: "WPP-1",
      title: "Prova; Penal, 2ª chamada",
      start: L("2026-11-20T14:00"),
      end: L("2026-11-20T17:00"),
      allDay: false,
      location: "Fórum",
      notes: "levar\ncódigo",
      reminderMinutes: 30,
    },
    TZ,
  );

  it("round-trips text escaping, times and the native alert", () => {
    expect(ours).toContain("TRIGGER:-PT30M");
    const [o] = parseOccurrences(ours, ...range("2026-11-20", "2026-11-21"), TZ);
    expect(o).toMatchObject({ title: "Prova; Penal, 2ª chamada", location: "Fórum", notes: "levar\ncódigo", reminderMinutes: 30 });
    expect(localDateTime(o!.start, TZ)).toBe("2026-11-20T14:00");
    expect(localDateTime(o!.end, TZ)).toBe("2026-11-20T17:00");
  });

  it("weekly RRULE with UNTIL keeps the last day", () => {
    const ics = buildIcs(
      {
        uid: "WPP-2", title: "Inglês", start: L("2026-11-17T18:00"), end: L("2026-11-17T19:00"), allDay: false,
        recurrence: { freq: "weekly", byWeekday: [2, 4], until: "2026-11-26" },
      },
      TZ,
    );
    const occ = parseOccurrences(ics, ...range("2026-11-01", "2027-01-01"), TZ).map((o) => localDateTime(o.start, TZ));
    expect(occ).toEqual(["2026-11-17T18:00", "2026-11-19T18:00", "2026-11-24T18:00", "2026-11-26T18:00"]);
  });

  it("patch keeps Apple-only properties and replaces the alarm", () => {
    const patched = patchIcs(APPLE_WEEKLY, { title: "Direito Civil", reminderMinutes: 60 }, TZ);
    expect(patched).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
    expect(patched).toContain("RECURRENCE-ID;TZID=America/Araguaina:20261123T190000");
    const m = parseMaster(patched, TZ)!;
    expect(m).toMatchObject({ title: "Direito Civil", reminderMinutes: 60 });
    expect(patched.match(/BEGIN:VALARM/g)).toHaveLength(1);
  });

  it("patch moves time (timed) and converts to all-day", () => {
    const moved = parseMaster(patchIcs(ours, { start: L("2026-11-21T09:00"), end: L("2026-11-21T10:00"), allDay: false }, TZ), TZ)!;
    expect(localDateTime(moved.startAt, TZ)).toBe("2026-11-21T09:00");
    const allDay = parseMaster(
      patchIcs(ours, { allDay: true, startDate: "2026-11-22", endDateExclusive: "2026-11-23", reminderMinutes: null }, TZ),
      TZ,
    )!;
    expect(allDay).toMatchObject({ allDay: true, reminderMinutes: null });
  });

  it("excluding one occurrence (TZID event) adds a matching EXDATE and drops its override", () => {
    const out = excludeOccurrence(APPLE_WEEKLY, L("2026-11-23T19:00"), TZ);
    expect(out).not.toContain("RECURRENCE-ID");
    const occ = parseOccurrences(out, ...range("2026-11-16", "2026-12-01"), TZ).map((o) => localDateTime(o.start, TZ));
    expect(occ).toEqual(["2026-11-16T19:00", "2026-11-25T19:00", "2026-11-30T19:00"]);
  });
});

describe("DST-safe recurrence (any timezone)", () => {
  const LIS = "Europe/Lisbon";
  const l = (s: string) => localToUtc(s, LIS);

  it("weekly class keeps 19:00 wall time across the March DST change", () => {
    const ics = buildIcs(
      { uid: "DST-1", title: "Aula", start: l("2027-03-16T19:00"), end: l("2027-03-16T21:00"), allDay: false, recurrence: { freq: "weekly", until: "2027-04-06" } },
      LIS,
    );
    expect(ics).toContain("DTSTART:20270316T190000\r\n"); // floating, no Z
    expect(ics).toContain("UNTIL=20270406T235959");
    const occ = parseOccurrences(ics, l("2027-03-01"), l("2027-05-01"), LIS).map((o) => localDateTime(o.start, LIS));
    expect(occ).toEqual(["2027-03-16T19:00", "2027-03-23T19:00", "2027-03-30T19:00", "2027-04-06T19:00"]);
  });

  it("one-off events stay exact instants (UTC)", () => {
    const ics = buildIcs({ uid: "DST-2", title: "Voo", start: l("2027-03-28T10:00"), end: l("2027-03-28T12:00"), allDay: false }, LIS);
    expect(ics).toMatch(/DTSTART:20270328T\d{6}Z/);
  });

  it("editing an iPhone event with TZID keeps its TZID (wall-clock semantics)", () => {
    const out = patchIcs(APPLE_WEEKLY, { start: L("2026-11-16T18:00"), end: L("2026-11-16T21:00"), allDay: false }, TZ);
    expect(out).toContain("DTSTART;TZID=America/Araguaina:20261116T180000");
    const occ = parseOccurrences(out, ...range("2026-11-16", "2026-11-26"), TZ).map((o) => localDateTime(o.start, TZ));
    expect(occ[0]).toBe("2026-11-16T18:00");
  });
});
