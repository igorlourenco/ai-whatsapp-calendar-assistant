import { isNotNull } from "drizzle-orm";

import {
  UserError,
  defaultCategory,
  normText,
  resolveTimes,
  slugify,
  sortOccurrences,
  type CalendarStore,
  type EventInput,
  type OccurrenceView,
  type StoreCategory,
  type StoreEvent,
} from "../calendar/store";
import type { Db } from "../db/client";
import { categories } from "../db/schema";
import {
  calendarHome,
  createCalendar,
  deleteObject,
  getObject,
  putObject,
  queryEvents,
  type ICloudEnv,
} from "./caldav";
import {
  buildIcs,
  excludeOccurrence,
  parseMaster,
  parseOccurrences,
  patchIcs,
  type EventPatch,
  type ParsedMaster,
  withUid,
} from "./ics";

const PALETTE = ["#FF2968", "#FF9500", "#FFCC00", "#63DA38", "#1BADF8", "#CC73E1", "#A2845E"];

type Cat = StoreCategory & { calendarUrl: string };

/**
 * iCloud is the source of truth for events. Neon only maps categories to
 * calendars (plus emoji). Event ids are the CalDAV object URLs.
 */
export function icloudStore(env: ICloudEnv, db: Db, tz: string, defaultReminder: number): CalendarStore {
  let catCache: Cat[] | null = null;

  async function cats(): Promise<Cat[]> {
    if (!catCache) {
      const rows = await db.select().from(categories).where(isNotNull(categories.calendarUrl));
      catCache = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        emoji: r.emoji,
        color: r.color,
        description: r.description,
        isDefault: r.isDefault,
        calendarUrl: r.calendarUrl!,
      }));
    }
    return catCache;
  }

  async function findCat(nameOrSlug: string | null | undefined): Promise<Cat | null> {
    if (!nameOrSlug) return null;
    const key = slugify(nameOrSlug);
    return (await cats()).find((c) => c.slug === key || slugify(c.name) === key) ?? null;
  }

  async function catOfHref(href: string): Promise<Cat | null> {
    return (await cats()).find((c) => href.startsWith(c.calendarUrl)) ?? null;
  }

  const toEvent = (id: string, m: ParsedMaster): StoreEvent => ({
    id,
    title: m.title,
    allDay: m.allDay,
    location: m.location,
    notes: m.notes,
    recurrence: m.recurrence,
    reminderMinutes: m.reminderMinutes,
    startAt: m.startAt,
    endAt: m.endAt,
  });

  async function read(href: string) {
    const obj = await getObject(env, href);
    if (!obj) return null;
    const master = parseMaster(obj.ics, tz);
    if (!master) return null;
    return { obj, master };
  }

  /** Deterministic UID per (message, title, start): a retried message PUTs the same object. */
  async function uidFor(input: EventInput): Promise<string> {
    if (!input.sourceMessageId) return crypto.randomUUID().toUpperCase();
    const data = new TextEncoder().encode(`${input.sourceMessageId}|${normText(input.title)}|${input.start}`);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `WPP-${hash.toUpperCase()}`;
  }

  return {
    async listCategories() {
      return (await cats()).map(({ calendarUrl: _, ...c }) => c);
    },

    async findCategory(n) {
      const c = await findCat(n);
      return c ? (({ calendarUrl: _, ...rest }) => rest)(c) : null;
    },

    async createCategory({ name, emoji, color }) {
      const existing = await findCat(name);
      if (existing) return existing;
      const hex = color ?? PALETTE[(await cats()).length % PALETTE.length]!;
      const url = await createCalendar(env, await calendarHome(env), name.trim(), hex);
      const [row] = await db
        .insert(categories)
        .values({ slug: slugify(name), name: name.trim(), emoji, color: hex, calendarUrl: url })
        .onConflictDoUpdate({ target: categories.slug, set: { calendarUrl: url, emoji, color: hex } })
        .returning();
      catCache = null;
      return { id: row!.id, slug: row!.slug, name: row!.name, emoji: row!.emoji, color: row!.color, description: null, isDefault: false };
    },

    async findOccurrences(from, to, opts = {}) {
      let list = await cats();
      if (opts.category) {
        const c = await findCat(opts.category);
        if (!c) return [];
        list = [c];
      }
      const q = opts.query ? normText(opts.query) : null;
      const perCal = await Promise.all(
        list.map(async (cat) => {
          const out: OccurrenceView[] = [];
          for (const obj of await queryEvents(env, cat.calendarUrl, from, to)) {
            const master = parseMaster(obj.ics, tz);
            if (!master) continue;
            const base = toEvent(obj.href, master);
            for (const o of parseOccurrences(obj.ics, from, to, tz)) {
              const event: StoreEvent = { ...base, title: o.title, location: o.location, notes: o.notes, reminderMinutes: o.reminderMinutes };
              if (q && ![event.title, event.notes ?? "", event.location ?? ""].some((t) => normText(t).includes(q))) continue;
              out.push({ event, category: cat, start: o.start, end: o.end });
            }
          }
          return out;
        }),
      );
      return perCal.flat().sort(sortOccurrences);
    },

    async getEvent(id) {
      const r = await read(id);
      if (!r) return null;
      return { ...toEvent(id, r.master), category: await catOfHref(id) };
    },

    async createEvent(input) {
      // Unknown category never blocks a save: it goes to the default calendar.
      const cat = (await findCat(input.category)) ?? defaultCategory(await cats());
      if (!cat) throw new Error("No iCloud calendar mapped to a category (run `pnpm configure`)");
      const t = resolveTimes(tz, input);
      const uid = await uidFor(input);
      const href = `${cat.calendarUrl}${uid}.ics`;
      const ics = buildIcs(
        {
          uid,
          title: input.title.trim(),
          start: t.startAt,
          end: t.endAt,
          allDay: input.allDay,
          startDate: t.startDay,
          endDateExclusive: t.endDay ?? undefined,
          location: input.location,
          notes: input.notes,
          recurrence: input.recurrence,
          reminderMinutes: input.allDay
            ? null
            : input.reminderMinutes === undefined
              ? defaultReminder
              : input.reminderMinutes,
        },
        tz,
      );
      try {
        await putObject(env, href, ics);
      } catch (err) {
        // 412 with If-None-Match: same message retried → object already there.
        if (!String(err).includes("412")) throw err;
      }
      const saved = await read(href);
      if (!saved) throw new Error("iCloud: event not readable after PUT");
      return toEvent(href, saved.master);
    },

    async updateEvent(id, patch) {
      const cur = await read(id);
      if (!cur) return null;
      const m = cur.master;
      const p: EventPatch = {};
      if (patch.title !== undefined) p.title = patch.title.trim();
      if (patch.location !== undefined) p.location = patch.location;
      if (patch.notes !== undefined) p.notes = patch.notes;
      if (patch.reminderMinutes !== undefined) p.reminderMinutes = patch.reminderMinutes;

      if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
        if (patch.start === undefined) throw new UserError("Faltou o novo dia ou horário.");
        const allDay = patch.allDay ?? m.allDay;
        const t = resolveTimes(tz, { start: patch.start, end: patch.end ?? null, allDay });
        Object.assign(p, { allDay, start: t.startAt, end: t.endAt, startDate: t.startDay, endDateExclusive: t.endDay ?? undefined });
        if (allDay) p.reminderMinutes = null;
        else if (m.allDay && patch.reminderMinutes === undefined) p.reminderMinutes = defaultReminder;
      }

      let ics = patchIcs(cur.obj.ics, p, tz);
      const targetCat = patch.category ? await findCat(patch.category) : null;
      const currentCat = await catOfHref(id);
      if (targetCat && currentCat && targetCat.calendarUrl !== currentCat.calendarUrl) {
        // Move = copy into the new calendar (iCloud rejects a duplicate UID
        // in the account, so the copy gets a fresh one), then delete the
        // original. Copy first: a failure never loses the event.
        const newUid = crypto.randomUUID().toUpperCase();
        const newHref = `${targetCat.calendarUrl}${newUid}.ics`;
        await putObject(env, newHref, withUid(ics, newUid));
        // The copy holds the patched content; the original just has to go.
        await deleteObject(env, id);
        const moved = await read(newHref);
        return moved ? toEvent(newHref, moved.master) : null;
      }
      try {
        await putObject(env, id, ics, cur.obj.etag || undefined);
      } catch (err) {
        if (!String(err).includes("412")) throw err;
        // Edited on the iPhone in between: re-read and re-apply once.
        const fresh = await read(id);
        if (!fresh) return null;
        ics = patchIcs(fresh.obj.ics, p, tz);
        try {
          await putObject(env, id, ics, fresh.obj.etag || undefined);
        } catch (err2) {
          if (!String(err2).includes("412")) throw err2;
          // Patch is applied on content just read: overwrite without If-Match.
          console.warn("[icloud] put 412 twice, writing unconditionally", String(err2));
          await putObject(env, id, ics, null);
        }
      }
      const saved = await read(id);
      return saved ? toEvent(id, saved.master) : null;
    },

    async deleteEvent(id, occurrenceStart) {
      const cur = await read(id);
      if (!cur) return "not_found";
      if (occurrenceStart && cur.master.recurrence) {
        const ics = excludeOccurrence(cur.obj.ics, new Date(occurrenceStart), tz);
        try {
          await putObject(env, id, ics, cur.obj.etag || undefined);
        } catch (err) {
          if (!String(err).includes("412")) throw err;
          console.warn("[icloud] exdate 412, re-reading", String(err));
          const fresh = await read(id);
          if (!fresh) return "not_found";
          await putObject(env, id, excludeOccurrence(fresh.obj.ics, new Date(occurrenceStart), tz), null);
        }
        return "occurrence_cancelled";
      }
      try {
        await deleteObject(env, id, cur.obj.etag || undefined);
      } catch (err) {
        if (!String(err).includes("412")) throw err;
        // Changed in between (or an ETag we can't match): the user asked for
        // it gone either way, so delete what's there now.
        console.warn("[icloud] delete 412, retrying unconditionally", String(err));
        await deleteObject(env, id);
      }
      return "deleted";
    },
  };
}

