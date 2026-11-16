/**
 * Compare events in Neon with what's already in iCloud. READ-ONLY.
 *   pnpm tsx --env-file=.dev.vars scripts/reconcile.ts
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "../src/worker/db/schema";
import { calendarHome, listCalendars, queryEvents } from "../src/worker/icloud/caldav";
import { parseOccurrences } from "../src/worker/icloud/ics";
import { localDateTime } from "../src/worker/time";

const TZ = "America/Araguaina";
const env = { ICLOUD_USERNAME: process.env.ICLOUD_USERNAME!, ICLOUD_APP_PASSWORD: process.env.ICLOUD_APP_PASSWORD! };
const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

const rows = await db.select().from(schema.events);
const cats = new Map((await db.select().from(schema.categories)).map((c) => [c.id, c.slug]));
if (!rows.length) {
  console.log("Neon has no events.");
  process.exit(0);
}
const from = new Date(Math.min(...rows.map((r) => r.startAt.getTime())) - 86_400_000);
const to = new Date(Math.max(...rows.map((r) => r.endAt.getTime())) + 86_400_000);

const home = await calendarHome(env);
const remote: { cal: string; title: string; start: Date; allDay: boolean }[] = [];
for (const cal of await listCalendars(env, home)) {
  for (const obj of await queryEvents(env, cal.url, from, to)) {
    for (const o of parseOccurrences(obj.ics, from, to, TZ)) remote.push({ cal: cal.name, title: o.title, start: o.start, allDay: o.allDay });
  }
}

let matched = 0;
const missing: string[] = [];
for (const r of rows) {
  const hit = remote.find(
    (x) =>
      x.start.getTime() === r.startAt.getTime() &&
      (norm(x.title) === norm(r.title) || norm(x.title).includes(norm(r.title)) || norm(r.title).includes(norm(x.title))),
  );
  const label = `${localDateTime(r.startAt, TZ)}${r.allDay ? " (dia todo)" : ""}  ${r.title}  [${cats.get(r.categoryId ?? "") ?? "-"}]${r.recurrence ? " 🔁" : ""}`;
  if (hit) {
    matched++;
    console.log(`✓ já no iCloud (${hit.cal}): ${label}${hit.title !== r.title ? `  ← lá: "${hit.title}"` : ""}`);
  } else missing.push(label);
}
for (const m of missing) console.log(`✗ só no banco: ${m}`);
console.log(`\nbanco: ${rows.length} | já no iCloud: ${matched} | só no banco: ${missing.length} | eventos no iCloud no período: ${remote.length}`);

const used = new Set<number>();
rows.forEach((r) => {
  const i = remote.findIndex((x, i) => !used.has(i) && x.start.getTime() === r.startAt.getTime() && (norm(x.title).includes(norm(r.title)) || norm(r.title).includes(norm(x.title)) || norm(x.title) === norm(r.title)));
  if (i >= 0) used.add(i);
});
console.log("\niCloud sem par exato no banco:");
remote.forEach((x, i) => { if (!used.has(i)) console.log(`  ${localDateTime(x.start, TZ)}${x.allDay ? " (dia todo)" : ""}  ${x.title}  (${x.cal})`); });
