/**
 * Live CalDAV round-trip on TEMPORARY calendars (deleted at the end).
 *   pnpm tsx --env-file=.dev.vars scripts/icloud-smoke.ts
 */
import * as schema from "../src/worker/db/schema";
import { calendarHome, createCalendar, deleteObject, getObject, listCalendars } from "../src/worker/icloud/caldav";
import { icloudStore } from "../src/worker/icloud/store";
import { memoryDb } from "../src/worker/testing/sqlite";
import { localDateTime, localToUtc } from "../src/worker/time";

const TZ = "America/Araguaina";
const env = { ICLOUD_USERNAME: process.env.ICLOUD_USERNAME!, ICLOUD_APP_PASSWORD: process.env.ICLOUD_APP_PASSWORD! };
const L = (s: string) => localToUtc(s, TZ);
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${info ? `  (${info})` : ""}`);
  if (!ok) failed++;
};

const db = await memoryDb();

const home = await calendarHome(env);
const tag = Date.now().toString(36);
const calA = await createCalendar(env, home, `zz-teste-bot-${tag}-a`, "#FF9500");
const calB = await createCalendar(env, home, `zz-teste-bot-${tag}-b`, "#63DA38");
await db.insert(schema.categories).values([
  { slug: "pessoal", name: "Pessoal", emoji: "🏠", calendarUrl: calA },
  { slug: "faculdade", name: "Faculdade", emoji: "🎓", calendarUrl: calB },
]);
const store = icloudStore(env, db, TZ, 30);

try {
  check("temp calendars listed", (await listCalendars(env, home)).filter((c) => c.name.includes(tag)).length === 2);

  const ev = await store.createEvent({ title: "Teste júri; vírgula, acento", start: "2026-12-01T14:00", end: "2026-12-01T17:00", allDay: false, category: "pessoal", location: "Fórum", sourceMessageId: "SMOKE-1" });
  check("create timed", localDateTime(ev.startAt, TZ) === "2026-12-01T14:00" && ev.reminderMinutes === 30, `${ev.title} alarm=${ev.reminderMinutes}`);

  const again = await store.createEvent({ title: "Teste júri; vírgula, acento", start: "2026-12-01T14:00", end: "2026-12-01T17:00", allDay: false, category: "pessoal", sourceMessageId: "SMOKE-1" });
  const day = await store.findOccurrences(L("2026-12-01"), L("2026-12-02"));
  check("retry of same message → same object, no duplicate", again.id === ev.id && day.length === 1);

  const rec = await store.createEvent({ title: "Aula teste", start: "2026-12-01T19:00", end: "2026-12-01T22:00", allDay: false, category: "faculdade", recurrence: { freq: "weekly", byWeekday: [2, 4], until: "2026-12-17" } });
  const all = await store.findOccurrences(L("2026-12-01"), L("2026-12-31"), { category: "faculdade" });
  check("weekly recurrence expands", all.length === 6, all.map((o) => localDateTime(o.start, TZ).slice(5, 10)).join(","));

  const cancel = all[1]!;
  check("cancel one occurrence", (await store.deleteEvent(rec.id, cancel.start)) === "occurrence_cancelled");
  const after = await store.findOccurrences(L("2026-12-01"), L("2026-12-31"), { category: "faculdade" });
  check("occurrence gone, others kept", after.length === 5 && !after.some((o) => o.start.getTime() === cancel.start.getTime()));

  const upd = await store.updateEvent(ev.id, { start: "2026-12-01T16:00", end: "2026-12-01T18:00", reminderMinutes: 60 });
  check("update time + alarm", !!upd && localDateTime(upd.startAt, TZ) === "2026-12-01T16:00" && upd.reminderMinutes === 60);

  const moved = await store.updateEvent(ev.id, { category: "faculdade" });
  check("move to other calendar", !!moved && moved.id.startsWith(calB) && (await getObject(env, ev.id)) === null);

  const ad = await store.createEvent({ title: "Viagem teste", start: "2026-12-20", end: "2026-12-23", allDay: true, category: "pessoal" });
  const mid = await store.findOccurrences(L("2026-12-22"), L("2026-12-23"));
  check("all-day multi-day", ad.allDay && mid.some((o) => o.event.id === ad.id));

  check("delete", (await store.deleteEvent(ad.id)) === "deleted" && (await store.getEvent(ad.id)) === null);
  check("delete missing → not_found", (await store.deleteEvent(ad.id)) === "not_found");
} finally {
  await deleteObject(env, calA);
  await deleteObject(env, calB);
  const left = (await listCalendars(env, home)).filter((c) => c.name.includes(tag));
  console.log(left.length ? `⚠️ temp calendars NOT removed: ${left.map((c) => c.name)}` : "🧹 temp calendars removed");
}
process.exit(failed ? 1 : 0);
