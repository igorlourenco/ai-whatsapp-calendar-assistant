import { and, asc, eq, isNull } from "drizzle-orm";

import { expandOccurrences } from "./calendar/recurrence";
import { normText } from "./calendar/store";
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

export type TaskPatch = { title?: string; dueDate?: string | null; dueTime?: string | null; notes?: string | null };

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

/** Search open tasks: every word must be in the title. */
export async function searchTasks(db: Db, search: string): Promise<Task[]> {
  const STOP = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "com", "e", "na", "no", "pra", "para", "minha", "meu", "tarefa"]);
  const words = normText(search).split(/\W+/u).filter((w) => w && !STOP.has(w));
  if (!words.length) return [];
  return (await openTasks(db)).filter((t) => words.every((w) => normText(t.title).includes(w)));
}

/* -------------------------------- nags ---------------------------------- */

/** When the nag for this task is due (timed open tasks only). */
export function nagAt(t: Task, tz: string): Date | null {
  if (t.status !== "open" || !t.dueDate || !t.dueTime || t.remindedAt) return null;
  return localToUtc(`${t.dueDate}T${t.dueTime}`, tz);
}

export async function pendingNags(db: Db): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "open"), isNull(tasks.remindedAt)));
}

/** Claim a nag (so overlapping runs never double-send). */
export async function claimNag(db: Db, id: string): Promise<boolean> {
  const res = await db
    .update(tasks)
    .set({ remindedAt: new Date() })
    .where(and(eq(tasks.id, id), isNull(tasks.remindedAt)))
    .returning({ id: tasks.id });
  return res.length > 0;
}

export async function releaseNag(db: Db, id: string): Promise<void> {
  await db.update(tasks).set({ remindedAt: null }).where(eq(tasks.id, id));
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

/** Numbered list; the numbers match the T1… refs the model gets next. */
export function formatTaskList(list: Task[], today: string, head = "📝 *Tarefas*"): string {
  if (!list.length) return "📝 Nenhuma tarefa aberta ✨";
  const lines = list.map((t, i) => `${i + 1}. ${taskLine(t, today)}`).join("\n");
  return `${head} (${list.length})\n${lines}\n\n_Responda “feito 1”, “adia o 2 pra sexta”…_`;
}

/** Compact section for digests and agenda queries (no numbering hint). */
export function taskSection(list: Task[], today: string, head = "📝 *Tarefas*"): string {
  return `${head}\n${list.map((t) => `• ${taskLine(t, today)}`).join("\n")}`;
}

export function toTaskRef(t: Task, today: string): TaskRef {
  return { taskId: t.id, label: taskLine(t, today) };
}
