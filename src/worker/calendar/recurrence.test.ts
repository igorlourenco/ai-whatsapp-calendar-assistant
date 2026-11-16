import { describe, expect, it } from "vitest";

import { localDateTime, localToUtc } from "../time";
import { expandOccurrences, recurrenceEnd } from "./recurrence";

const TZ = "America/Araguaina";

describe("localToUtc", () => {
  it("converts BRT wall time", () => {
    expect(localToUtc("2026-11-16T07:00", TZ).toISOString()).toBe("2026-11-16T10:00:00.000Z");
    expect(localDateTime(new Date("2026-11-17T00:30:00Z"), TZ)).toBe("2026-11-16T21:30");
  });
  it("handles DST zones", () => {
    expect(localToUtc("2026-07-01T12:00", "Europe/Lisbon").toISOString()).toBe(
      "2026-07-01T11:00:00.000Z",
    );
  });
});

const L = (s: string) => localToUtc(s, TZ);

describe("expandOccurrences", () => {
  it("single event overlap", () => {
    const ev = { startAt: L("2026-11-20T14:00"), endAt: L("2026-11-20T15:00"), allDay: false, recurrence: null, exdates: [] };
    expect(expandOccurrences(ev, L("2026-11-20"), L("2026-11-21"), TZ)).toHaveLength(1);
    expect(expandOccurrences(ev, L("2026-11-21"), L("2026-11-22"), TZ)).toHaveLength(0);
  });

  it("multi-day all-day overlaps each day", () => {
    const ev = { startAt: L("2026-12-20"), endAt: L("2026-12-24"), allDay: true, recurrence: null, exdates: [] };
    expect(expandOccurrences(ev, L("2026-12-22"), L("2026-12-23"), TZ)).toHaveLength(1);
    expect(expandOccurrences(ev, L("2026-12-24"), L("2026-12-25"), TZ)).toHaveLength(0);
  });

  it("weekly on mon/wed with until and exdate", () => {
    const ev = {
      startAt: L("2026-11-16T19:00"),
      endAt: L("2026-11-16T22:00"),
      allDay: false,
      recurrence: { freq: "weekly" as const, byWeekday: [1, 3], until: "2026-12-02" },
      exdates: [L("2026-11-25T19:00").toISOString()],
    };
    const occ = expandOccurrences(ev, L("2026-11-01"), L("2027-01-01"), TZ).map((o) => localDateTime(o.start, TZ));
    expect(occ).toEqual([
      "2026-11-16T19:00",
      "2026-11-18T19:00",
      "2026-11-23T19:00",
      "2026-11-30T19:00",
      "2026-12-02T19:00",
    ]);
  });

  it("monthly skips short months, count limits", () => {
    const ev = {
      startAt: L("2027-01-31T09:00"),
      endAt: L("2027-01-31T10:00"),
      allDay: false,
      recurrence: { freq: "monthly" as const, count: 3 },
      exdates: [],
    };
    const occ = expandOccurrences(ev, L("2027-01-01"), L("2028-01-01"), TZ).map((o) => localDateTime(o.start, TZ));
    expect(occ).toEqual(["2027-01-31T09:00", "2027-03-31T09:00", "2027-05-31T09:00"]);
    expect(localDateTime(recurrenceEnd(ev, TZ)!, TZ)).toBe("2027-05-31T09:00");
  });

  it("keeps wall time across DST", () => {
    const start = localToUtc("2026-03-01T10:00", "America/New_York");
    const ev = {
      startAt: start,
      endAt: new Date(start.getTime() + 3600_000),
      allDay: false,
      recurrence: { freq: "weekly" as const },
      exdates: [],
    };
    const occ = expandOccurrences(ev, start, localToUtc("2026-03-20", "America/New_York"), "America/New_York");
    expect(occ.map((o) => localDateTime(o.start, "America/New_York").slice(11))).toEqual([
      "10:00", "10:00", "10:00",
    ]);
  });
});
