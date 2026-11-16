import { formatAgenda, formatLine } from "../calendar/format";
import {
  UserError,
  normText,
  slugify,
  type CalendarStore,
  type EventInput,
  type OccurrenceView,
} from "../calendar/store";
import type { Db } from "../db/client";
import { messageEvents, type FocusItem, type PendingPick, type Recurrence } from "../db/schema";
import { addDays, diffDays, localDate, localDateTime, localTime, localToUtc, shortDatePt } from "../time";
import { renderConfirmations } from "./confirm";
import type { DeepSeekEnv } from "./deepseek";
import { extractActions, type Action } from "./extract";
import { loadState, pushFocus, saveState, toFocus, type State } from "./state";

export type AppCtx = {
  store: CalendarStore;
  /** Neon: inbox, state, logs (events live in the store). */
  db: Db;
  tz: string;
  defaultReminder: number;
  /** WhatsApp message being handled; makes creates idempotent on retry. */
  sourceMessageId?: string | null;
};

export type WriteRecord =
  | { kind: "event_saved"; action: "created" | "updated" | "exists"; eventId: string }
  | { kind: "event_deleted"; title: string; occurrenceStart: Date | null }
  | { kind: "category"; action: "created"; label: string };

export const HELP_TEXT = `🤔 Não entendi. Exemplos:
• _dentista sexta 15h_
• _prova de penal dia 25_
• _aula de civil toda terça e quinta 19h às 22h_
• _o que tenho amanhã?_
• _muda o dentista pra 16h_
• _cancela a academia de segunda_`;

/**
 * One message in, one reply out. The only context is the structured State
 * (pending draft + recently touched events), built by code; the model never
 * sees past replies.
 */
export async function handleMessage(ctx: AppCtx, env: DeepSeekEnv, text: string): Promise<string> {
  const state = await loadState(ctx.db);
  const categories = await ctx.store.listCategories();
  const actions = await extractActions(env, text, { now: new Date(), tz: ctx.tz, categories, state });
  console.log("[extract]", JSON.stringify(actions));
  const result = await executeActions(ctx, actions, state);
  await saveState(ctx.db, result.state);
  return result.reply;
}

type Turn = {
  writes: WriteRecord[];
  /** Focus as shown to the model this turn: refs E1… resolve against THIS list. */
  shown: FocusItem[];
  /** Pending "qual deles?" from the previous message (its changes are reused). */
  pick: PendingPick | null;
  /** State after this message. Pending questions only survive if re-asked. */
  next: State;
};

/**
 * Run actions in order and build the reply. Every confirmation is rendered
 * from rows re-read from the database (renderConfirmations); an action that
 * can't be done produces an explicit "❌/❓" line, never a fake success.
 */
export async function executeActions(
  ctx: AppCtx,
  actions: Action[],
  state: State = { draft: null, focus: [] },
): Promise<{ reply: string; state: State }> {
  const parts: string[] = [];
  const turn: Turn = {
    writes: [],
    shown: state.focus,
    pick: state.pick ?? null,
    next: { draft: null, pick: null, focus: state.focus },
  };

  const flushWrites = async () => {
    if (!turn.writes.length) return;
    const writes = turn.writes.splice(0);
    parts.push(await renderConfirmations(ctx, writes));
    const saved = writes.filter((w) => w.kind === "event_saved").map((w) => w.eventId);
    const items: FocusItem[] = [];
    for (const id of saved.reverse()) {
      const f = await focusForEvent(ctx, id);
      if (f) items.push(f);
    }
    turn.next.focus = pushFocus(turn.next.focus, items);
  };

  for (const a of actions) {
    try {
      const out = await run(ctx, a, turn);
      if (out) {
        await flushWrites();
        parts.push(out);
      }
    } catch (err) {
      // Infra failures (DB, etc.) propagate: the inbox retries the message,
      // and creates are idempotent. Only user-input problems are answered.
      if (!(err instanceof UserError)) throw err;
      await flushWrites();
      parts.push(`❌ ${err.message} ${a.type === "create" ? "Nada foi salvo." : "Nada foi alterado."}`);
    }
  }
  await flushWrites();
  return { reply: parts.join("\n\n") || HELP_TEXT, state: turn.next };
}

/** Returns text to show, or null when the result is a write (confirmed later from DB). */
async function run(ctx: AppCtx, a: Action, turn: Turn): Promise<string | null> {
  switch (a.type) {
    case "create": {
      if (!a.date) {
        // Missing required info: keep it as a draft and ask. Nothing saved.
        const { type: _, ...draft } = a;
        turn.next.draft = { ...draft, recurrence: cleanRecurrence(a.recurrence) };
        return `❓ *${a.title}*: qual dia${a.start_time ? "" : " e horário (se tiver)"}?`;
      }
      const input = createInput(ctx, a, a.date);
      const dup = await findDuplicate(ctx, input);
      if (dup) {
        turn.writes.push({ kind: "event_saved", action: "exists", eventId: dup });
        return null;
      }
      const ev = await ctx.store.createEvent(input);
      turn.writes.push({ kind: "event_saved", action: "created", eventId: ev.id });
      if (ctx.sourceMessageId) {
        await ctx.db
          .insert(messageEvents)
          .values({ messageId: ctx.sourceMessageId, eventId: ev.id, label: `${ev.title} — ${localDateTime(ev.startAt, ctx.tz).replace("T", " ")}` })
          .onConflictDoNothing();
      }
      return null;
    }
    case "update": {
      const target = await resolveRefOrSearch(ctx, a, turn, { action: "update", changes: stripNulls(a.changes) });
      if ("reply" in target) return target.reply;
      // Answer to "qual deles?": reuse the changes asked for in the previous message.
      const changes =
        turn.pick?.action === "update" && a.ref ? { ...(turn.pick.changes as Changes), ...stripNulls(a.changes) } : a.changes;
      const patch = updatePatch(ctx, target.event, changes);
      if (!Object.keys(patch).length) {
        turn.next.focus = pushFocus(turn.next.focus, [toFocus(target, ctx.tz)]);
        return `❓ Mudar o quê em *${target.event.title}*? (dia, horário, nome, local, lembrete…)`;
      }
      const ev = await ctx.store.updateEvent(target.event.id, patch);
      if (!ev) throw new UserError("Esse evento não existe mais.");
      turn.writes.push({ kind: "event_saved", action: "updated", eventId: ev.id });
      return null;
    }
    case "delete": {
      const target = await resolveRefOrSearch(ctx, a, turn, { action: "delete", only_that_day: a.only_that_day });
      if ("reply" in target) return target.reply;
      const onlyThatDay = a.only_that_day ?? (turn.pick?.action === "delete" ? turn.pick.only_that_day : null);
      const single = !!(onlyThatDay && target.event.recurrence);
      const result = await ctx.store.deleteEvent(target.event.id, single ? target.start : null);
      if (result === "not_found") throw new UserError("Esse evento não existe mais.");
      turn.writes.push({
        kind: "event_deleted",
        title: target.event.title,
        occurrenceStart: single ? target.start : null,
      });
      if (!single) turn.next.focus = turn.next.focus.filter((f) => f.eventId !== target.event.id);
      return null;
    }
    case "query": {
      const to = a.to < a.from ? a.from : a.to;
      const occ = await ctx.store.findOccurrences(localToUtc(a.from, ctx.tz), localToUtc(addDays(to, 1), ctx.tz), {
        category: a.category,
        query: a.search,
      });
      if (occ.length) turn.next.focus = occ.slice(0, 10).map((o) => toFocus(o, ctx.tz));
      return formatAgenda(occ, a.from, to, ctx.tz, {
        emptyText: `🗓️ Nada marcado ${a.from === to ? `em ${shortDatePt(a.from)}` : `de ${shortDatePt(a.from)} a ${shortDatePt(to)}`} ✨`,
      });
    }
    case "create_category": {
      const c = await ctx.store.createCategory({ name: a.name, emoji: a.emoji });
      turn.writes.push({ kind: "category", action: "created", label: `${c.emoji} ${c.name}` });
      return null;
    }
    case "unknown":
      return HELP_TEXT;
  }
}

/** Same title + same start already saved → don't duplicate (e.g. model re-creating a focus event). */
async function findDuplicate(ctx: AppCtx, input: EventInput): Promise<string | null> {
  const startAt = localToUtc(input.start, ctx.tz);
  const occ = await ctx.store.findOccurrences(startAt, new Date(startAt.getTime() + 60_000));
  const title = normText(input.title);
  const hit = occ.find(
    (o) => o.start.getTime() === startAt.getTime() && o.event.allDay === input.allDay && normText(o.event.title) === title,
  );
  return hit?.event.id ?? null;
}

/** Next upcoming occurrence of an event (or its first one), as a focus item. */
async function focusForEvent(ctx: AppCtx, eventId: string): Promise<FocusItem | null> {
  const ev = await ctx.store.getEvent(eventId);
  if (!ev) return null;
  const now = new Date();
  const occ = ev.recurrence
    ? (await ctx.store.findOccurrences(now, new Date(now.getTime() + 60 * 86_400_000))).find((o) => o.event.id === eventId)
    : undefined;
  const start = occ?.start ?? ev.startAt;
  const end = occ?.end ?? ev.endAt;
  return toFocus({ event: ev, category: ev.category, start, end }, ctx.tz);
}

/**
 * A named event (search) always wins over a ref: if the user said the name
 * and several events match, they get asked which one instead of the model
 * silently picking the most recent.
 */
async function resolveRefOrSearch(
  ctx: AppCtx,
  a: { ref?: string | null; search?: string | null; on_date?: string | null },
  turn: Turn,
  pick: PendingPick,
): Promise<OccurrenceView | { reply: string }> {
  if (a.search) return resolveTarget(ctx, a.search, a.on_date ?? undefined, turn, pick);
  if (a.ref) {
    const n = Number(/^E?(\d+)$/i.exec(a.ref.trim())?.[1]);
    const item = turn.shown[n - 1];
    if (!item) return { reply: "❓ Não sei qual evento. Manda com o nome (ex: _muda o dentista pra 16h_)." };
    const ev = await ctx.store.getEvent(item.eventId);
    if (!ev) return { reply: `❓ *${item.label.split(" — ")[0]}* não existe mais. Nada foi alterado.` };
    const start = new Date(item.occurrenceStart);
    return { event: ev, category: ev.category, start, end: new Date(start.getTime() + (ev.endAt.getTime() - ev.startAt.getTime())) };
  }
  return { reply: "❓ Não sei qual evento. Manda com o nome (ex: _muda o dentista pra 16h_)." };
}

function createInput(ctx: AppCtx, a: Extract<Action, { type: "create" }>, date: string): EventInput {
  const allDay = !a.start_time;
  let end: string | null = null;
  if (allDay) end = a.last_date ?? null;
  else if (a.end_time) {
    // "22h às 2h" crosses midnight.
    const endDay = a.end_time <= a.start_time! ? addDays(a.last_date ?? date, a.last_date ? 0 : 1) : (a.last_date ?? date);
    end = `${endDay}T${a.end_time}`;
  } else if (a.last_date) end = `${a.last_date}T23:59`;

  return {
    title: a.title,
    start: allDay ? date : `${date}T${a.start_time}`,
    end,
    allDay,
    category: a.category ? slugify(a.category) : null,
    location: a.location ?? null,
    notes: a.notes ?? null,
    recurrence: cleanRecurrence(a.recurrence),
    reminderMinutes: reminder(a.reminder_minutes),
    sourceMessageId: ctx.sourceMessageId,
  };
}

function cleanRecurrence(r: Extract<Action, { type: "create" }>["recurrence"]): Recurrence | null {
  if (!r) return null;
  return {
    freq: r.freq,
    ...(r.interval ? { interval: r.interval } : {}),
    ...(r.byWeekday?.length ? { byWeekday: r.byWeekday } : {}),
    ...(r.until ? { until: r.until } : {}),
    ...(r.count ? { count: r.count } : {}),
  };
}

/** null/undefined → default; 0 ("sem lembrete") → none. */
function reminder(v: number | null | undefined): number | null | undefined {
  if (v == null) return undefined;
  return v === 0 ? null : v;
}

type Changes = Extract<Action, { type: "update" }>["changes"];

function stripNulls<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;
}

/** Merge partial date/time changes ("pra 16h", "pra sexta") with the event's current values. */
function updatePatch(ctx: AppCtx, ev: OccurrenceView["event"], c: Changes): Partial<EventInput> {
  const patch: Partial<EventInput> = {};
  if (c.title) patch.title = c.title;
  if (c.category) patch.category = slugify(c.category);
  if (c.location) patch.location = c.location;
  if (c.notes) patch.notes = c.notes;
  if (c.reminder_minutes != null) patch.reminderMinutes = reminder(c.reminder_minutes);

  const timing = c.date || c.start_time || c.end_time || c.all_day != null || c.last_date;
  if (!timing) return patch;

  const curStartDate = localDate(ev.startAt, ctx.tz);
  const curLastDate = localDate(new Date(ev.endAt.getTime() - 1), ctx.tz);
  const allDay = c.all_day ?? (c.start_time ? false : ev.allDay);
  const date = c.date ?? curStartDate;

  if (allDay) {
    const span = diffDays(curStartDate, curLastDate);
    patch.allDay = true;
    patch.start = date;
    patch.end = c.last_date ?? (ev.allDay ? addDays(date, span) : date);
    return patch;
  }

  const startTime = c.start_time ?? (ev.allDay ? null : localTime(ev.startAt, ctx.tz));
  if (!startTime) throw new UserError("Pra tirar do dia todo preciso do horário (ex: \"muda pra 15h\").");
  const start = `${date}T${startTime}`;
  let end: string;
  if (c.end_time) {
    end = `${c.end_time <= startTime ? addDays(date, 1) : date}T${c.end_time}`;
  } else {
    const duration = ev.allDay ? 60 * 60_000 : ev.endAt.getTime() - ev.startAt.getTime();
    end = localDateTime(new Date(localToUtc(start, ctx.tz).getTime() + duration), ctx.tz);
  }
  patch.allDay = false;
  patch.start = start;
  patch.end = end;
  return patch;
}

const norm = normText;
const STOPWORDS = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "com", "e", "na", "no", "pra", "para", "minha", "meu"]);

/**
 * Find the single event the user means. Deterministic: all search words must
 * appear in the title. Prefers upcoming occurrences. Zero or several matches
 * → a reply explaining it, nothing is changed.
 */
async function resolveTarget(
  ctx: AppCtx,
  search: string,
  onDate: string | undefined,
  turn: Turn,
  pick: PendingPick,
): Promise<OccurrenceView | { reply: string }> {
  const today = localDate(new Date(), ctx.tz);
  const from = onDate ?? addDays(today, -60);
  const to = onDate ? addDays(onDate, 1) : addDays(today, 400);
  const words = norm(search).split(/\W+/u).filter((w) => w && !STOPWORDS.has(w));
  const occ = (await ctx.store.findOccurrences(localToUtc(from, ctx.tz), localToUtc(to, ctx.tz))).filter((o) =>
    words.every((w) => norm(o.event.title).includes(w)),
  );

  // One occurrence per event: the next upcoming one, else the latest past one.
  const nowMs = Date.now();
  const byEvent = new Map<string, OccurrenceView>();
  for (const o of occ) {
    const cur = byEvent.get(o.event.id);
    const upcoming = o.end.getTime() > nowMs;
    if (!cur || (upcoming && cur.end.getTime() <= nowMs) || (!upcoming && cur.end.getTime() <= nowMs && o.start > cur.start)) {
      byEvent.set(o.event.id, o);
    }
  }
  const matches = [...byEvent.values()];
  const where = onDate ? ` em ${shortDatePt(onDate)}` : "";

  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    return { reply: `❓ Não achei nenhum evento com “${search}”${where}. Nada foi alterado.` };
  }
  // The numbered list becomes the focus, so "o 2" next message maps to E2.
  const shown = matches.slice(0, 9);
  turn.next.focus = shown.map((o) => toFocus(o, ctx.tz));
  turn.next.pick = pick;
  const list = shown
    .map((o, i) => `${i + 1}. ${formatLine(o, localDate(o.start, ctx.tz), ctx.tz)} — ${shortDatePt(localDate(o.start, ctx.tz))}`)
    .join("\n");
  return {
    reply: `❓ Achei ${matches.length} eventos com “${search}”${where}. Qual deles? (responde com o número)\n${list}`,
  };
}
