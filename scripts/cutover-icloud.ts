/**
 * One-time switch to iCloud: map categories → calendars, copy events that
 * exist only in Neon (listed explicitly), reset conversation state.
 *   pnpm tsx --env-file=.dev.vars scripts/cutover-icloud.ts
 */
import { neon } from "@neondatabase/serverless";
import { eq, ilike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "../src/worker/db/schema";
import { calendarHome, listCalendars } from "../src/worker/icloud/caldav";
import { icloudStore } from "../src/worker/icloud/store";
import { localDateTime } from "../src/worker/time";

const TZ = "America/Araguaina";
const env = { ICLOUD_USERNAME: process.env.ICLOUD_USERNAME!, ICLOUD_APP_PASSWORD: process.env.ICLOUD_APP_PASSWORD! };
const db = drizzle(neon(process.env.DATABASE_URL!), { schema });

// category slug → iCloud calendar display name ("Home" intentionally left out)
const MAP: Record<string, string> = { faculdade: "faculdade", trabalho: "trabalho", pessoal: "personal" };
// Neon-only events approved for copy (reconcile.ts)
const COPY = ["Tribunal do júri do professor"];

const cals = await listCalendars(env, await calendarHome(env));
for (const [slug, calName] of Object.entries(MAP)) {
  const cal = cals.find((c) => c.name === calName);
  if (!cal) throw new Error(`calendar "${calName}" not found`);
  await db
    .update(schema.categories)
    .set({ calendarUrl: cal.url, ...(cal.color ? { color: cal.color } : {}) })
    .where(eq(schema.categories.slug, slug));
  console.log(`✓ ${slug} → iCloud "${calName}"`);
}

const store = icloudStore(env, db, TZ, 30);
const catById = new Map((await db.select().from(schema.categories)).map((c) => [c.id, c.slug]));
for (const title of COPY) {
  const [row] = await db.select().from(schema.events).where(ilike(schema.events.title, title));
  if (!row) throw new Error(`"${title}" not in Neon`);
  const created = await store.createEvent({
    title: row.title,
    start: localDateTime(row.startAt, TZ),
    end: localDateTime(row.endAt, TZ),
    allDay: row.allDay,
    category: catById.get(row.categoryId ?? "") ?? null,
    location: row.location,
    notes: row.notes,
    recurrence: row.recurrence,
    reminderMinutes: row.reminderMinutes,
    sourceMessageId: `cutover:${row.id}`, // idempotent if re-run
  });
  const back = await store.getEvent(created.id);
  console.log(back ? `✓ copiado e relido do iCloud: ${back.title} ${localDateTime(back.startAt, TZ)}–${localDateTime(back.endAt, TZ).slice(11)} [${back.category?.slug}] alerta ${back.reminderMinutes} min` : "✗ NOT readable after copy");
}

await db.delete(schema.assistantState);
console.log("✓ conversation state reset");
