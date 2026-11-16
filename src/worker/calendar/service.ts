import { and, asc, eq, gt, ilike, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { categories, events, type Category, type EventRow, type Recurrence } from "../db/schema";
import {
  UserError,
  resolveTimes,
  slugify,
  sortOccurrences,
  type CalendarStore,
  type EventInput,
  type OccurrenceView,
} from "./store";
import { expandOccurrences, recurrenceEnd } from "./recurrence";

/**
 * Postgres CalendarStore. Used by tests and the eval (PGlite); production
 * stores events in iCloud (icloud/store.ts).
 */
type Ctx = { db: Db; tz: string; defaultReminder: number };

/* ------------------------------ categories ------------------------------ */

export async function listCategories(ctx: Ctx): Promise<Category[]> {
  return ctx.db.select().from(categories).orderBy(asc(categories.name));
}

export async function findCategory(ctx: Ctx, nameOrSlug: string): Promise<Category | null> {
  const slug = slugify(nameOrSlug);
  const [row] = await ctx.db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return row ?? null;
}

export async function createCategory(
  ctx: Ctx,
  input: { name: string; emoji: string; color?: string },
): Promise<Category> {
  const [row] = await ctx.db
    .insert(categories)
    .values({
      slug: slugify(input.name),
      name: input.name.trim(),
      emoji: input.emoji,
      ...(input.color ? { color: input.color } : {}),
    })
    .onConflictDoUpdate({
      target: categories.slug,
      set: { emoji: input.emoji, ...(input.color ? { color: input.color } : {}) },
    })
    .returning();
  return row!;
}

export async function updateCategory(
  ctx: Ctx,
  slugOrName: string,
  patch: { name?: string; emoji?: string; color?: string },
): Promise<Category | null> {
  const set: Partial<typeof categories.$inferInsert> = {};
  if (patch.name) Object.assign(set, { name: patch.name.trim(), slug: slugify(patch.name) });
  if (patch.emoji) set.emoji = patch.emoji;
  if (patch.color) set.color = patch.color;
  if (Object.keys(set).length === 0) return findCategory(ctx, slugOrName);
  const [row] = await ctx.db
    .update(categories)
    .set(set)
    .where(eq(categories.slug, slugify(slugOrName)))
    .returning();
  return row ?? null;
}

export async function deleteCategory(ctx: Ctx, slugOrName: string): Promise<boolean> {
  const rows = await ctx.db
    .delete(categories)
    .where(eq(categories.slug, slugify(slugOrName)))
    .returning({ id: categories.id });
  return rows.length > 0;
}

/* -------------------------------- events -------------------------------- */

async function categoryIdFor(ctx: Ctx, name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const cat = await findCategory(ctx, name);
  // Unknown category never blocks a save: the event is stored uncategorized
  // and the confirmation shows "sem categoria".
  if (!cat) console.warn("[service] unknown category, saving without", { name });
  return cat?.id ?? null;
}

export async function createEvent(ctx: Ctx, input: EventInput): Promise<EventRow> {
  const { startAt, endAt } = resolveTimes(ctx.tz, input);
  const title = input.title.trim();

  // Idempotency: an inbox retry of the same WhatsApp message re-runs the LLM;
  // if it asks for the same event again, hand back the one already saved.
  if (input.sourceMessageId) {
    const [existing] = await ctx.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.sourceMessageId, input.sourceMessageId),
          eq(events.startAt, startAt),
          ilike(events.title, title.replace(/[%_\\]/g, "")),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }

  const recurrence = input.recurrence ?? null;
  const base = { startAt, endAt, allDay: input.allDay, recurrence, exdates: [] };
  const [row] = await ctx.db
    .insert(events)
    .values({
      title,
      sourceMessageId: input.sourceMessageId ?? null,
      notes: input.notes ?? null,
      location: input.location ?? null,
      categoryId: await categoryIdFor(ctx, input.category),
      ...base,
      recurrenceEndAt: recurrence ? recurrenceEnd(base, ctx.tz) : null,
      reminderMinutes: input.allDay
        ? null
        : input.reminderMinutes === undefined
          ? ctx.defaultReminder
          : input.reminderMinutes,
    })
    .returning();
  return row!;
}

export async function getEvent(ctx: Ctx, id: string): Promise<EventRow | null> {
  const [row] = await ctx.db.select().from(events).where(eq(events.id, id)).limit(1);
  return row ?? null;
}

export async function updateEvent(
  ctx: Ctx,
  id: string,
  patch: Partial<EventInput>,
): Promise<EventRow | null> {
  const current = await getEvent(ctx, id);
  if (!current) return null;

  const set: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.location !== undefined) set.location = patch.location;
  if (patch.category !== undefined) set.categoryId = await categoryIdFor(ctx, patch.category);
  if (patch.reminderMinutes !== undefined) set.reminderMinutes = patch.reminderMinutes;

  const timesChanged =
    patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined;
  if (timesChanged) {
    const allDay = patch.allDay ?? current.allDay;
    if (patch.start === undefined) {
      throw new UserError("Faltou o novo dia ou horário.");
    }
    { const t = resolveTimes(ctx.tz, { start: patch.start, end: patch.end ?? null, allDay }); set.startAt = t.startAt; set.endAt = t.endAt; }
    set.allDay = allDay;
    if (allDay) set.reminderMinutes = null;
    else if (current.allDay && patch.reminderMinutes === undefined)
      set.reminderMinutes = ctx.defaultReminder;
  }
  if (patch.recurrence !== undefined) set.recurrence = patch.recurrence;

  if (timesChanged || patch.recurrence !== undefined) {
    const merged = {
      startAt: set.startAt ?? current.startAt,
      endAt: set.endAt ?? current.endAt,
      allDay: set.allDay ?? current.allDay,
      recurrence: set.recurrence === undefined ? current.recurrence : set.recurrence,
      exdates: [],
    };
    set.recurrenceEndAt = merged.recurrence ? recurrenceEnd(merged, ctx.tz) : null;
  }

  const [row] = await ctx.db.update(events).set(set).where(eq(events.id, id)).returning();
  return row ?? null;
}

/**
 * Delete an event. For a recurring event, pass `occurrenceStart` (ISO) to
 * cancel only that occurrence.
 */
export async function deleteEvent(
  ctx: Ctx,
  id: string,
  occurrenceStart?: Date | string | null,
): Promise<"deleted" | "occurrence_cancelled" | "not_found"> {
  const current = await getEvent(ctx, id);
  if (!current) return "not_found";
  if (occurrenceStart && current.recurrence) {
    const iso = new Date(occurrenceStart).toISOString();
    await ctx.db
      .update(events)
      .set({ exdates: [...current.exdates, iso], updatedAt: new Date() })
      .where(eq(events.id, id));
    return "occurrence_cancelled";
  }
  await ctx.db.delete(events).where(eq(events.id, id));
  return "deleted";
}

/** All occurrences overlapping [from, to), sorted (all-day first per day, then by time). */
export async function findOccurrences(
  ctx: Ctx,
  from: Date,
  to: Date,
  opts: { category?: string | null; query?: string | null } = {},
): Promise<OccurrenceView[]> {
  const conds = [
    lt(events.startAt, to),
    or(
      and(isNull(events.recurrence), gt(events.endAt, from)),
      and(
        isNotNull(events.recurrence),
        or(
          isNull(events.recurrenceEndAt),
          sql`${events.recurrenceEndAt} + (${events.endAt} - ${events.startAt}) > ${from.toISOString()}`,
        ),
      ),
    ),
  ];
  if (opts.category) {
    const cat = await findCategory(ctx, opts.category);
    if (!cat) return [];
    conds.push(eq(events.categoryId, cat.id));
  }
  if (opts.query) {
    const q = `%${opts.query.replace(/[%_]/g, "")}%`;
    conds.push(or(ilike(events.title, q), ilike(events.notes, q), ilike(events.location, q))!);
  }

  const rows = await ctx.db
    .select({ event: events, category: categories })
    .from(events)
    .leftJoin(categories, eq(events.categoryId, categories.id))
    .where(and(...conds));

  const out: OccurrenceView[] = [];
  for (const { event, category } of rows) {
    for (const occ of expandOccurrences(event, from, to, ctx.tz)) {
      out.push({ event, category, start: occ.start, end: occ.end });
    }
  }
  return out.sort(sortOccurrences);
}

export function pgStore(db: Db, tz: string, defaultReminder: number): CalendarStore {
  const ctx: Ctx = { db, tz, defaultReminder };
  return {
    listCategories: () => listCategories(ctx),
    findCategory: (n) => findCategory(ctx, n),
    createCategory: (i) => createCategory(ctx, i),
    findOccurrences: (from, to, opts) => findOccurrences(ctx, from, to, opts),
    async getEvent(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [row] = await db
        .select({ event: events, category: categories })
        .from(events)
        .leftJoin(categories, eq(events.categoryId, categories.id))
        .where(eq(events.id, id))
        .limit(1);
      return row ? { ...row.event, category: row.category } : null;
    },
    createEvent: (i) => createEvent(ctx, i),
    updateEvent: (id, p) => updateEvent(ctx, id, p),
    deleteEvent: (id, occ) => deleteEvent(ctx, id, occ),
  };
}
