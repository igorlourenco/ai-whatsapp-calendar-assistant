import { asc, eq } from "drizzle-orm";

import { expandOccurrences } from "./calendar/recurrence";
import { defaultCategory, matchTitles, normText, type StoreCategory } from "./calendar/store";
import type { Db } from "./db/client";
import { tasks, type Recurrence, type Task, type TaskRef } from "./db/schema";
import { addDays, diffDays, localDate, localToUtc, shortDatePt, weekdayOf } from "./time";

/*
 * To-dos live in the Durable Object's SQLite (Apple's Reminders app isn't
 * reachable over CalDAV). Dates are local wall-clock (YYYY-MM-DD / HH:mm) in
 * the configured timezone, like everything the user types.
 */

export type TaskInput = {
  title: string;
  dueDate?: string | null;
  dueTime?: string | null;
  recurrence?: Recurrence | null;
  notes?: string | null;
  /** Category slug. */
  category?: string | null;
};

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** Deterministic per message + title, so a retried message never duplicates. */
export function taskId(sourceMessageId: string | null | undefined, title: string): string {
  return sourceMessageId ? `${sourceMessageId}:${normText(title)}` : crypto.randomUUID();
}

export async function getTask(db: Db, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}

/** Insert (or no-op on retry). Returns the stored row. */
export async function createTask(db: Db, id: string, input: TaskInput): Promise<Task> {
  await db
    .insert(tasks)
    .values({
      id,
      title: input.title,
      dueDate: input.dueDate ?? null,
      dueTime: input.dueDate ? (input.dueTime ?? null) : null,
      recurrence: input.dueDate ? (input.recurrence ?? null) : null,
      notes: input.notes ?? null,
      category: input.category ?? null,
    })
    .onConflictDoNothing();
  const row = await getTask(db, id);
  if (!row) throw new Error(`task ${id} not found after insert`);
  return row;
}

/** Open tasks: overdue/soonest first, then undated, oldest first. */
export async function openTasks(db: Db): Promise<Task[]> {
  const rows = await db.select().from(tasks).where(eq(tasks.status, "open")).orderBy(asc(tasks.createdAt));
  return rows.sort(byDue);
}

export function byDue(a: Task, b: Task): number {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.dueTime !== b.dueTime) {
    if (!a.dueTime) return -1; // date-only first (it's "for the whole day")
    if (!b.dueTime) return 1;
    return a.dueTime < b.dueTime ? -1 : 1;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** Open tasks due in [from, to] (inclusive); plus overdue ones when `withOverdue`. */
export async function tasksDue(db: Db, from: string, to: string, withOverdue = false): Promise<Task[]> {
  return (await openTasks(db)).filter((t) => t.dueDate && t.dueDate <= to && (t.dueDate >= from || withOverdue));
}

/** Same title already open with the same due → don't duplicate. */
export async function findDuplicateTask(db: Db, input: TaskInput): Promise<Task | null> {
  const title = normText(input.title);
  return (
    (await openTasks(db)).find(
      (t) => normText(t.title) === title && t.dueDate === (input.dueDate ?? null) && t.dueTime === (input.dueDate ? (input.dueTime ?? null) : null),
    ) ?? null
  );
}

export type TaskPatch = { title?: string; /** null = no date ("algum dia"). */ dueDate?: string | null; dueTime?: string | null; notes?: string | null; category?: string };

export async function updateTask(db: Db, id: string, patch: TaskPatch): Promise<Task | null> {
  const cur = await getTask(db, id);
  if (!cur) return null;
  const dueDate = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
  const dueTime = !dueDate ? null : patch.dueTime !== undefined ? patch.dueTime : cur.dueTime;
  const dueChanged = dueDate !== cur.dueDate || dueTime !== cur.dueTime;
  await db
    .update(tasks)
    .set({
      title: patch.title ?? cur.title,
      notes: patch.notes !== undefined ? patch.notes : cur.notes,
      category: patch.category ?? cur.category,
      dueDate,
      dueTime,
      recurrence: dueDate ? cur.recurrence : null,
      // A new due time gets a new nag.
      remindedAt: dueChanged ? null : cur.remindedAt,
    })
    .where(eq(tasks.id, id));
  return getTask(db, id);
}

/**
 * Mark done. A repeating task instead moves to its next due date (and stays
 * open); `next` is that date, or null when the series is over.
 */
export async function completeTask(db: Db, id: string, tz: string): Promise<{ task: Task; next: string | null } | null> {
  const cur = await getTask(db, id);
  if (!cur) return null;
  const next = cur.recurrence && cur.dueDate ? nextDue(cur.dueDate, cur.recurrence, tz) : null;
  if (next) {
    await db.update(tasks).set({ dueDate: next, remindedAt: null }).where(eq(tasks.id, id));
  } else {
    await db.update(tasks).set({ status: "done", doneAt: new Date() }).where(eq(tasks.id, id));
  }
  return { task: (await getTask(db, id))!, next };
}

export async function deleteTask(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  return res.length > 0;
}

/** First date of the series strictly after `after`. */
export function nextDue(after: string, r: Recurrence, tz: string): string | null {
  const anchor = localToUtc(after, tz);
  const occ = expandOccurrences(
    { startAt: anchor, endAt: new Date(anchor.getTime() + 60_000), allDay: true, recurrence: { ...r, count: undefined }, exdates: [] },
    localToUtc(addDays(after, 1), tz),
    localToUtc(addDays(after, 400), tz),
    tz,
  );
  const first = occ[0];
  if (!first) return null;
  return localDate(first.start, tz);
}

const TASK_STOP = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "com", "e", "na", "no", "pra", "para", "minha", "meu", "tarefa"]);

/** Search open tasks: every word in the title (or, failing that, its root). */
export async function searchTasks(db: Db, search: string): Promise<Task[]> {
  return matchTitles(await openTasks(db), (t) => t.title, search, TASK_STOP);
}

/* -------------------------------- nags ---------------------------------- */

/*
 * From its due moment on, a task is re-sent every `every` minutes until it's
 * marked done (or moved to another day). Due moment = its time, or for a
 * date-only task one interval after the morning digest (which already lists
 * it). `every` 0 = never nag. No nags after `until`; they resume the next morning. Overdue tasks
 * keep being nagged every day.
 */
export type NagCfg = { morningAt: string; /** 0 = nags off */ every: number; until: string };

const plusMinutes = (hhmm: string, m: number) => {
  const [h, mm] = hhmm.split(":").map(Number) as [number, number];
  const t = Math.min(h * 60 + mm + m, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** [start, end) of the nag window for `t` on local `day`. */
function nagWindow(t: Task, day: string, cfg: NagCfg, tz: string): [Date, Date] {
  const first = day === t.dueDate && t.dueTime ? t.dueTime : plusMinutes(cfg.morningAt, cfg.every);
  const start = localToUtc(`${day}T${first}`, tz);
  // A task due after `until` still gets nagged once, at its time.
  const end = first >= cfg.until ? new Date(start.getTime() + 1) : localToUtc(`${day}T${cfg.until}`, tz);
  return [start, end];
}

/** When this task should be nagged next (≤ now means "now"); null if never. */
export function nextNagAt(t: Task, cfg: NagCfg, tz: string, now: Date): Date | null {
  if (cfg.every <= 0 || t.status !== "open" || !t.dueDate) return null;
  const today = localDate(now, tz);
  let day = t.dueDate > today ? t.dueDate : today;
  for (let i = 0; i < 3; i++, day = addDays(day, 1)) {
    const [start, end] = nagWindow(t, day, cfg, tz);
    const after = t.remindedAt ? new Date(t.remindedAt.getTime() + cfg.every * 60_000) : start;
    const at = after > start ? after : start;
    if (at < end) return at;
  }
  return null;
}

/** Inside its nag window right now (so it rides along in the current nag). */
export function inNagPhase(t: Task, cfg: NagCfg, tz: string, now: Date): boolean {
  if (cfg.every <= 0 || t.status !== "open" || !t.dueDate) return false;
  const today = localDate(now, tz);
  if (t.dueDate > today) return false;
  const [start, end] = nagWindow(t, today, cfg, tz);
  return start <= now && now < end;
}

/** Mark these tasks as nagged at `at`; returns the previous values (to undo on send failure). */
export async function markNagged(db: Db, list: Task[], at: Date): Promise<() => Promise<void>> {
  for (const t of list) await db.update(tasks).set({ remindedAt: at }).where(eq(tasks.id, t.id));
  return async () => {
    for (const t of list) await db.update(tasks).set({ remindedAt: t.remindedAt }).where(eq(tasks.id, t.id));
  };
}

/* ------------------------------ formatting ------------------------------ */

/** "hoje 10:00", "amanhã", "sex 20/11", "⚠️ atrasada (seg 16/11)". */
export function dueLabel(t: Pick<Task, "dueDate" | "dueTime">, today: string): string | null {
  if (!t.dueDate) return null;
  const diff = diffDays(today, t.dueDate);
  const day =
    diff === 0 ? "hoje" : diff === 1 ? "amanhã" : `${WEEKDAY_SHORT[weekdayOf(t.dueDate)]} ${shortDatePt(t.dueDate)}`;
  if (diff < 0) return `⚠️ atrasada (${WEEKDAY_SHORT[weekdayOf(t.dueDate)]} ${shortDatePt(t.dueDate)}${t.dueTime ? ` ${t.dueTime}` : ""})`;
  return t.dueTime ? `${day} ${t.dueTime}` : day;
}

/** "Pagar boleto — hoje 10:00 🔁" */
export function taskLine(t: Task, today: string): string {
  const due = dueLabel(t, today);
  return `${t.title}${due ? ` — ${due}` : ""}${t.recurrence ? " 🔁" : ""}`;
}

/* ------------------------------ categories ------------------------------ */

/** The task's category: its own slug if it still exists, else the default one. */
export function taskCategory<C extends StoreCategory>(t: Pick<Task, "category">, cats: C[]): C | null {
  return (t.category && cats.find((c) => c.slug === t.category)) || defaultCategory(cats);
}

/**
 * Tasks grouped by category; groups in order of their most urgent task (input
 * is due-ordered, so: first appearance), each keeping the due order. `list`
 * is the same tasks reordered to match: number i in the grouped message is
 * list[i - 1], so T refs must be built from it.
 */
export function groupTasks(tasks: Task[], cats: StoreCategory[]): { list: Task[]; groups: { cat: StoreCategory | null; tasks: Task[] }[] } {
  const groups = new Map<string, { cat: StoreCategory | null; tasks: Task[] }>();
  for (const t of tasks) {
    const cat = taskCategory(t, cats);
    const key = cat?.slug ?? "";
    if (!groups.has(key)) groups.set(key, { cat, tasks: [] });
    groups.get(key)!.tasks.push(t);
  }
  const out = [...groups.values()];
  return { list: out.flatMap((g) => g.tasks), groups: out };
}

/**
 * Numbered list; the numbers match the T1… refs the model gets next. With
 * tasks in more than one category, one block per category (numbering
 * continues across blocks). Pass tasks already ordered by groupTasks.
 */
export function formatTaskList(list: Task[], today: string, head = "📝 *Tarefas*", cats: StoreCategory[] = []): string {
  if (!list.length) return "📝 Nenhuma tarefa aberta ✨";
  const { groups } = groupTasks(list, cats);
  let n = 0;
  const line = (t: Task) => `${++n}. ${taskLine(t, today)}`;
  const body =
    groups.length > 1
      ? groups.map((g) => `${g.cat ? `${g.cat.emoji} *${g.cat.name}*` : "📌 *Outras*"}\n${g.tasks.map(line).join("\n")}`).join("\n\n")
      : list.map(line).join("\n");
  return `${head} (${list.length})\n${body}\n\n_Responda “feito 1”, “adia o 2 pra sexta”…_`;
}

/** Compact section for digests and agenda queries (no numbering hint). */
export function taskSection(list: Task[], today: string, head = "📝 *Tarefas*"): string {
  return `${head}\n${list.map((t) => `• ${taskLine(t, today)}`).join("\n")}`;
}

export function toTaskRef(t: Task, today: string): TaskRef {
  return { taskId: t.id, label: taskLine(t, today) };
}
