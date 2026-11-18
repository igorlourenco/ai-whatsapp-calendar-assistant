import { and, eq, gte, isNotNull, lt, or } from "drizzle-orm";

import type { Db } from "../db/client";
import { categories, events, type Recurrence } from "../db/schema";
import { expandOccurrences } from "./recurrence";
import {
  UserError,
  defaultCategory,
  normText,
  resolveTimes,
  slugify,
  sortOccurrences,
  type CalendarStore,
  type StoreCategory,
  type StoreEvent,
} from "./store";

const PALETTE = ["#FF2968", "#FF9500", "#FFCC00", "#63DA38", "#1BADF8", "#CC73E1", "#A2845E"];

/** Categories every new user starts with. */
export const GUEST_CATEGORIES = [
  { slug: "pessoal", name: "Pessoal", emoji: "🏠", description: "todo o resto", isDefault: true },
  { slug: "trabalho", name: "Trabalho", emoji: "💼", description: "emprego, reuniões, clientes", isDefault: false },
  { slug: "estudos", name: "Estudos", emoji: "🎓", description: "aulas, provas, faculdade, cursos", isDefault: false },
];

type Row = typeof events.$inferSelect;

/**
 * Events in the Durable Object's own SQLite: the store for users without
 * iCloud. Same semantics as the iCloud and in-memory stores (idempotent
 * creates per message, occurrence cancel, unknown category → default).
 */
export function sqliteStore(db: Db, tz: string, defaultReminder: number): CalendarStore & { allRows(): Promise<Row[]> } {
  async function cats(): Promise<StoreCategory[]> {
    const rows = await db.select().from(categories);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      emoji: r.emoji,
      color: r.color,
      description: r.description,
      isDefault: r.isDefault,
    }));
  }
  const findCat = async (n: string | null | undefined) => {
    if (!n) return null;
    const key = slugify(n);
    return (await cats()).find((c) => c.slug === key || slugify(c.name) === key) ?? null;
  };
  const view = (r: Row): StoreEvent => ({
    id: r.id,
    title: r.title,
    allDay: r.allDay,
    location: r.location,
    notes: r.notes,
    recurrence: r.recurrence ?? null,
    reminderMinutes: r.reminderMinutes,
    startAt: r.startAt,
    endAt: r.endAt,
  });
  const get = async (id: string) => (await db.select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null;

  return {
    allRows: () => db.select().from(events),

    async listCategories() {
      return (await cats()).sort((a, b) => a.name.localeCompare(b.name));
    },
    findCategory: findCat,
    async createCategory({ name, emoji, color }) {
      const existing = await findCat(name);
      if (existing) return existing;
      const n = (await cats()).length;
      const [row] = await db
        .insert(categories)
        .values({ slug: slugify(name), name: name.trim(), emoji, color: color ?? PALETTE[n % PALETTE.length]! })
        .returning();
      return { id: row!.id, slug: row!.slug, name: row!.name, emoji: row!.emoji, color: row!.color, description: null, isDefault: false };
    },

    async findOccurrences(from, to, opts = {}) {
      const cat = opts.category ? await findCat(opts.category) : null;
      if (opts.category && !cat) return [];
      const q = opts.query ? normText(opts.query) : null;
      const all = await cats();
      // One-offs overlapping the window, plus every recurring master.
      const rows = await db
        .select()
        .from(events)
        .where(or(isNotNull(events.recurrence), and(lt(events.startAt, to), gte(events.endAt, from))));
      return rows
        .filter((r) => !cat || r.categoryId === cat.id)
        .filter((r) => !q || [r.title, r.notes ?? "", r.location ?? ""].some((t) => normText(t).includes(q)))
        .flatMap((r) => {
          const category = all.find((c) => c.id === r.categoryId) ?? null;
          return expandOccurrences({ ...r, recurrence: r.recurrence ?? null }, from, to, tz).map((o) => ({
            event: view(r),
            category,
            start: o.start,
            end: o.end,
          }));
        })
        .sort(sortOccurrences);
    },

    async getEvent(id) {
      const r = await get(id);
      if (!r) return null;
      return { ...view(r), category: (await cats()).find((c) => c.id === r.categoryId) ?? null };
    },

    async createEvent(input) {
      const t = resolveTimes(tz, input);
      const title = input.title.trim();
      if (input.sourceMessageId) {
        const same = (await db.select().from(events).where(eq(events.sourceMessageId, input.sourceMessageId))).find(
          (r) => r.startAt.getTime() === t.startAt.getTime() && normText(r.title) === normText(title),
        );
        if (same) return view(same);
      }
      const cat = (await findCat(input.category)) ?? defaultCategory(await cats());
      const [row] = await db
        .insert(events)
        .values({
          id: crypto.randomUUID(),
          title,
          allDay: input.allDay,
          startAt: t.startAt,
          endAt: t.endAt,
          categoryId: cat?.id ?? null,
          location: input.location ?? null,
          notes: input.notes ?? null,
          recurrence: (input.recurrence ?? null) as Recurrence | null,
          reminderMinutes: input.allDay ? null : input.reminderMinutes === undefined ? defaultReminder : input.reminderMinutes,
          sourceMessageId: input.sourceMessageId ?? null,
        })
        .returning();
      return view(row!);
    },

    async updateEvent(id, patch) {
      const r = await get(id);
      if (!r) return null;
      const set: Partial<Row> = { updatedAt: new Date() };
      if (patch.title !== undefined) set.title = patch.title.trim();
      if (patch.location !== undefined) set.location = patch.location;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.category !== undefined) set.categoryId = (await findCat(patch.category))?.id ?? r.categoryId;
      if (patch.reminderMinutes !== undefined) set.reminderMinutes = patch.reminderMinutes;
      if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
        if (patch.start === undefined) throw new UserError("Faltou o novo dia ou horário.");
        const allDay = patch.allDay ?? r.allDay;
        const t = resolveTimes(tz, { start: patch.start, end: patch.end ?? null, allDay });
        if (allDay) set.reminderMinutes = null;
        else if (r.allDay && patch.reminderMinutes === undefined) set.reminderMinutes = defaultReminder;
        Object.assign(set, { startAt: t.startAt, endAt: t.endAt, allDay });
      }
      await db.update(events).set(set).where(eq(events.id, id));
      const updated = await get(id);
      return updated ? view(updated) : null;
    },

    async deleteEvent(id, occurrenceStart) {
      const r = await get(id);
      if (!r) return "not_found";
      if (occurrenceStart && r.recurrence) {
        await db
          .update(events)
          .set({ exdates: [...r.exdates, new Date(occurrenceStart).toISOString()], updatedAt: new Date() })
          .where(eq(events.id, id));
        return "occurrence_cancelled";
      }
      await db.delete(events).where(eq(events.id, id));
      return "deleted";
    },
  };
}
