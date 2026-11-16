import type { StoreCategory, StoreEvent } from "../calendar/store";
import type { Recurrence } from "../db/schema";
import type { Task } from "../db/schema";
import { getTask } from "../tasks";
import { humanDatePt, localDate, localTime, shortDatePt } from "../time";
import type { AppCtx, WriteRecord } from "./execute";

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/**
 * Confirmation text for this turn's writes, built ONLY from rows re-read from
 * the database. If a write can't be read back, this throws: the inbox then
 * retries instead of telling the user something was saved.
 */
export async function renderConfirmations(ctx: AppCtx, writes: WriteRecord[]): Promise<string> {
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const w of writes) {
    if (w.kind === "event_saved") {
      if (seen.has(w.eventId)) continue;
      seen.add(w.eventId);
      const row = await ctx.store.getEvent(w.eventId);
      if (!row) throw new Error(`write verification failed: event ${w.eventId} not found after ${w.action}`);
      const head = { created: "✅ *Salvo na agenda*", updated: "✏️ *Atualizado*", exists: "ℹ️ *Já estava na agenda*" }[w.action];
      blocks.push(`${head}\n${describe(ctx, row, row.category)}`);
    } else if (w.kind === "event_deleted") {
      blocks.push(
        w.occurrenceStart
          ? `🗑️ *Cancelado* só em ${shortDatePt(localDate(w.occurrenceStart, ctx.tz))}: ${w.title}`
          : `🗑️ *Apagado:* ${w.title}`,
      );
    } else if (w.kind === "task") {
      const key = `task:${w.taskId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = await getTask(ctx.db, w.taskId);
      if (!t) throw new Error(`write verification failed: task ${w.taskId} not found after ${w.action}`);
      if (w.action === "done") {
        if (w.next) {
          if (t.dueDate !== w.next) throw new Error(`write verification failed: task ${w.taskId} not moved to ${w.next}`);
          blocks.push(`✅ *Feito:* ${t.title}\n🔁 próxima: ${humanDatePt(w.next)}${t.dueTime ? ` · ${t.dueTime}` : ""}`);
        } else {
          if (t.status !== "done") throw new Error(`write verification failed: task ${w.taskId} still open`);
          blocks.push(`✅ *Feito:* ${t.title}`);
        }
        continue;
      }
      const head = { created: "📝 *Tarefa anotada*", updated: "✏️ *Tarefa atualizada*", exists: "ℹ️ *Já estava na lista*" }[w.action];
      blocks.push(`${head}\n${describeTask(t, ctx.taskNagMinutes ?? 30)}`);
    } else if (w.kind === "task_deleted") {
      blocks.push(`🗑️ *Tarefa apagada:* ${w.title}`);
    } else {
      blocks.push(`🏷️ Categoria criada: ${w.label}`);
    }
  }
  return blocks.join("\n\n");
}

function describe(ctx: AppCtx, ev: StoreEvent, cat: StoreCategory | null): string {
  const emoji = cat?.emoji ?? "📌";
  const startDay = localDate(ev.startAt, ctx.tz);
  const lastDay = localDate(new Date(ev.endAt.getTime() - 1), ctx.tz);

  let when: string;
  if (ev.allDay) {
    when =
      startDay === lastDay
        ? `${humanDatePt(startDay)} · dia todo`
        : `${shortDatePt(startDay)} a ${shortDatePt(lastDay)} · dia todo`;
  } else if (startDay === lastDay) {
    when = `${humanDatePt(startDay)} · ${localTime(ev.startAt, ctx.tz)}–${localTime(ev.endAt, ctx.tz)}`;
  } else {
    when = `${shortDatePt(startDay)} ${localTime(ev.startAt, ctx.tz)} → ${shortDatePt(lastDay)} ${localTime(ev.endAt, ctx.tz)}`;
  }

  const lines = [`${emoji} *${ev.title}*`, `🗓️ ${when}`];
  if (ev.location) lines.push(`📍 ${ev.location}`);
  if (ev.recurrence) lines.push(`🔁 ${describeRecurrence(ev.recurrence, startDay)}`);
  if (!ev.allDay && ev.reminderMinutes != null) lines.push(`⏰ lembrete ${ev.reminderMinutes} min antes`);
  if (!cat) lines.push("🏷️ sem categoria");
  return lines.join("\n");
}

function describeTask(t: Task, every: number): string {
  const lines = [`*${t.title}*`];
  if (t.dueDate) {
    lines.push(`🗓️ ${humanDatePt(t.dueDate)}${t.dueTime ? ` · ${t.dueTime}` : ""}`);
    lines.push(`⏰ te cobro a cada ${every} min${t.dueTime ? ` a partir das ${t.dueTime}` : ""} até você dizer *feito*`);
  }
  if (t.recurrence && t.dueDate) lines.push(`🔁 ${describeRecurrence(t.recurrence, t.dueDate)}`);
  if (t.notes) lines.push(`📝 ${t.notes}`);
  return lines.join("\n");
}

function describeRecurrence(r: Recurrence, startDay: string): string {
  const n = r.interval ?? 1;
  let base: string;
  switch (r.freq) {
    case "daily":
      base = n === 1 ? "todo dia" : `a cada ${n} dias`;
      break;
    case "weekly": {
      const days = r.byWeekday?.length ? r.byWeekday : [new Date(`${startDay}T12:00:00Z`).getUTCDay()];
      const list = days.map((d) => WEEKDAY_SHORT[d]).join(", ");
      base = n === 1 ? `toda semana (${list})` : `a cada ${n} semanas (${list})`;
      break;
    }
    case "monthly":
      base = n === 1 ? `todo mês, dia ${Number(startDay.slice(8))}` : `a cada ${n} meses`;
      break;
    case "yearly":
      base = "todo ano";
      break;
  }
  if (r.until) base += ` até ${shortDatePt(r.until)}`;
  if (r.count) base += ` (${r.count}x)`;
  return base;
}

