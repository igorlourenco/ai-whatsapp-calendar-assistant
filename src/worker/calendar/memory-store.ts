import type { Recurrence } from "../db/schema";
import { expandOccurrences } from "./recurrence";
import {
  UserError,
  normText,
  resolveTimes,
  slugify,
  sortOccurrences,
  type CalendarStore,
  type EventInput,
  type StoreCategory,
  type StoreEvent,
} from "./store";

type Row = StoreEvent & { categoryId: string | null; sourceMessageId: string | null; exdates: string[] };

/**
 * In-memory CalendarStore with the same semantics as the iCloud one
 * (idempotent creates per message, occurrence cancel, unknown category →
 * default). Used by tests and the eval; production uses icloud/store.ts.
 */
export function memoryStore(
  tz: string,
  defaultReminder: number,
  seed: { slug: string; name: string; emoji: string; color?: string }[] = [],
): CalendarStore & { all(): Row[] } {
  const cats: StoreCategory[] = seed.map((c) => ({ id: crypto.randomUUID(), color: "#64748b", ...c }));
  const rows: Row[] = [];

  const findCat = (n: string | null | undefined) => {
    if (!n) return null;
    const key = slugify(n);
    return cats.find((c) => c.slug === key || slugify(c.name) === key) ?? null;
  };
  const view = (r: Row): StoreEvent => ({
    id: r.id,
    title: r.title,
    allDay: r.allDay,
    location: r.location,
    notes: r.notes,
    recurrence: r.recurrence,
    reminderMinutes: r.reminderMinutes,
    startAt: r.startAt,
    endAt: r.endAt,
  });
  const catOf = (r: Row) => cats.find((c) => c.id === r.categoryId) ?? null;

  return {
    all: () => rows,

    async listCategories() {
      return [...cats].sort((a, b) => a.name.localeCompare(b.name));
    },
    async findCategory(n) {
      return findCat(n);
    },
    async createCategory({ name, emoji, color }) {
      const existing = findCat(name);
      if (existing) return existing;
      const c = { id: crypto.randomUUID(), slug: slugify(name), name: name.trim(), emoji, color: color ?? "#64748b" };
      cats.push(c);
      return c;
    },

    async findOccurrences(from, to, opts = {}) {
      const cat = opts.category ? findCat(opts.category) : null;
      if (opts.category && !cat) return [];
      const q = opts.query ? normText(opts.query) : null;
      return rows
        .filter((r) => !cat || r.categoryId === cat.id)
        .filter((r) => !q || [r.title, r.notes ?? "", r.location ?? ""].some((t) => normText(t).includes(q)))
        .flatMap((r) =>
          expandOccurrences(r, from, to, tz).map((o) => ({ event: view(r), category: catOf(r), start: o.start, end: o.end })),
        )
        .sort(sortOccurrences);
    },

    async getEvent(id) {
      const r = rows.find((x) => x.id === id);
      return r ? { ...view(r), category: catOf(r) } : null;
    },

    async createEvent(input) {
      const t = resolveTimes(tz, input);
      const title = input.title.trim();
      if (input.sourceMessageId) {
        const same = rows.find(
          (r) => r.sourceMessageId === input.sourceMessageId && r.startAt.getTime() === t.startAt.getTime() && normText(r.title) === normText(title),
        );
        if (same) return view(same);
      }
      const cat = findCat(input.category) ?? findCat("pessoal");
      const row: Row = {
        id: crypto.randomUUID(),
        title,
        allDay: input.allDay,
        location: input.location ?? null,
        notes: input.notes ?? null,
        recurrence: (input.recurrence ?? null) as Recurrence | null,
        reminderMinutes: input.allDay ? null : input.reminderMinutes === undefined ? defaultReminder : input.reminderMinutes,
        startAt: t.startAt,
        endAt: t.endAt,
        categoryId: cat?.id ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        exdates: [],
      };
      rows.push(row);
      return view(row);
    },

    async updateEvent(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      if (patch.title !== undefined) r.title = patch.title.trim();
      if (patch.location !== undefined) r.location = patch.location;
      if (patch.notes !== undefined) r.notes = patch.notes;
      if (patch.category !== undefined) r.categoryId = findCat(patch.category)?.id ?? r.categoryId;
      if (patch.reminderMinutes !== undefined) r.reminderMinutes = patch.reminderMinutes;
      if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
        if (patch.start === undefined) throw new UserError("Faltou o novo dia ou horário.");
        const allDay = patch.allDay ?? r.allDay;
        const t = resolveTimes(tz, { start: patch.start, end: patch.end ?? null, allDay });
        if (allDay) r.reminderMinutes = null;
        else if (r.allDay && patch.reminderMinutes === undefined) r.reminderMinutes = defaultReminder;
        Object.assign(r, { startAt: t.startAt, endAt: t.endAt, allDay });
      }
      return view(r);
    },

    async deleteEvent(id, occurrenceStart) {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return "not_found";
      const r = rows[i]!;
      if (occurrenceStart && r.recurrence) {
        r.exdates.push(new Date(occurrenceStart).toISOString());
        return "occurrence_cancelled";
      }
      rows.splice(i, 1);
      return "deleted";
    },
  };
}
