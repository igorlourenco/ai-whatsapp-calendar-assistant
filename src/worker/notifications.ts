import { capitalize, formatAgenda, formatLine } from "./calendar/format";
import type { CalendarStore } from "./calendar/store";
import { and, eq, gte } from "drizzle-orm";

import type { Db } from "./db/client";

import { digestLog, reminderLog } from "./db/schema";
import { addDays, hhmmToMinutes, humanDatePt, localDate, localToUtc, toLocalParts } from "./time";

type Send = (message: string) => Promise<void>;

/** What notifications need: the event store + Neon (for send claims). */
export type Ctx = { store: CalendarStore; db: Db; tz: string };

export type CronConfig = { morningAt: string; eveningAt: string };

/** Window after the target time in which a missed digest is still sent. */
const DIGEST_GRACE_MIN = 120;
/** Don't fire reminders for events that started more than this long ago. */
const REMINDER_LATE_MS = 5 * 60_000;
/** How far ahead to look for reminders (bounds the largest usable reminder_minutes). */
const REMINDER_LOOKAHEAD_MS = 8 * 86_400_000;

/** Send everything due at `now`: reminders and digests. Idempotent. */
export async function runDue(ctx: Ctx, cfg: CronConfig, send: Send, now = new Date()) {
  await Promise.all([sendReminders(ctx, send, now), sendDigests(ctx, cfg, send, now)]);
}

/**
 * When the scheduler should wake next: the earliest of the next digest time
 * and the next reminder due time. Returns `now` if an unsent reminder is
 * already due (e.g. event created 10 min before start with a 30 min reminder).
 */
export async function nextWakeUp(ctx: Ctx, cfg: CronConfig, now = new Date()): Promise<Date> {
  const today = localDate(now, ctx.tz);
  let next = [today, addDays(today, 1)]
    .flatMap((d) => [cfg.morningAt, cfg.eveningAt].map((t) => localToUtc(`${d}T${t}`, ctx.tz)))
    .filter((d) => d > now)
    .reduce((a, b) => (a < b ? a : b));

  const since = new Date(now.getTime() - REMINDER_LATE_MS);
  const [occ, sent] = await Promise.all([
    ctx.store.findOccurrences(since, new Date(now.getTime() + REMINDER_LOOKAHEAD_MS)),
    ctx.db
      .select({ eventId: reminderLog.eventId, occurrenceStart: reminderLog.occurrenceStart })
      .from(reminderLog)
      .where(gte(reminderLog.occurrenceStart, since)),
  ]);
  const sentKeys = new Set(sent.map((r) => `${r.eventId}:${r.occurrenceStart.getTime()}`));

  for (const o of occ) {
    const mins = o.event.reminderMinutes;
    if (o.event.allDay || mins == null || o.start < since) continue;
    if (sentKeys.has(`${o.event.id}:${o.start.getTime()}`)) continue;
    const due = new Date(o.start.getTime() - mins * 60_000);
    if (due <= now) return now;
    if (due < next) next = due;
  }
  return next;
}

async function sendReminders(ctx: Ctx, send: Send, now: Date) {
  const occ = await ctx.store.findOccurrences(new Date(now.getTime() - REMINDER_LATE_MS),
    new Date(now.getTime() + REMINDER_LOOKAHEAD_MS),
  );
  const failures: unknown[] = [];
  for (const o of occ) {
    const mins = o.event.reminderMinutes;
    if (o.event.allDay || mins == null) continue;
    if (o.start.getTime() < now.getTime() - REMINDER_LATE_MS) continue; // only check starts
    if (o.start.getTime() - mins * 60_000 > now.getTime()) continue; // not due yet

    // Claim first so overlapping runs never double-send; release on failure
    // so the alarm retry sends it again.
    const claimed = await ctx.db
      .insert(reminderLog)
      .values({ eventId: o.event.id, occurrenceStart: o.start })
      .onConflictDoNothing()
      .returning();
    if (!claimed.length) continue;

    const left = Math.round((o.start.getTime() - now.getTime()) / 60_000);
    const when = left <= 0 ? "Começando agora" : `Daqui a ${humanMinutes(left)}`;
    try {
      await send(`⏰ ${when}:\n${formatLine(o, localDate(o.start, ctx.tz), ctx.tz)}`);
    } catch (err) {
      failures.push(err);
      await ctx.db
        .delete(reminderLog)
        .where(and(eq(reminderLog.eventId, o.event.id), eq(reminderLog.occurrenceStart, o.start)));
    }
  }
  if (failures.length) throw new AggregateError(failures, "reminder send failed");
}

async function sendDigests(ctx: Ctx, cfg: CronConfig, send: Send, now: Date) {
  const p = toLocalParts(now, ctx.tz);
  const nowMin = p.hour * 60 + p.minute;
  const today = localDate(now, ctx.tz);

  const due = (at: string) => {
    const t = hhmmToMinutes(at);
    return nowMin >= t && nowMin < t + DIGEST_GRACE_MIN;
  };
  const claim = async (kind: "morning" | "evening") =>
    (
      await ctx.db
        .insert(digestLog)
        .values({ kind, localDate: today })
        .onConflictDoNothing()
        .returning()
    ).length > 0;

  const release = (kind: "morning" | "evening") =>
    ctx.db.delete(digestLog).where(and(eq(digestLog.kind, kind), eq(digestLog.localDate, today)));
  const deliver = async (kind: "morning" | "evening", build: () => Promise<string>) => {
    if (!(await claim(kind))) return;
    try {
      await send(await build());
    } catch (err) {
      await release(kind);
      throw err;
    }
  };

  if (due(cfg.morningAt)) await deliver("morning", () => morningDigest(ctx, today));
  if (due(cfg.eveningAt)) await deliver("evening", () => eveningDigest(ctx, addDays(today, 1)));
}

export async function morningDigest(ctx: Ctx, today: string): Promise<string> {
  const occ = await ctx.store.findOccurrences(localToUtc(today, ctx.tz), localToUtc(addDays(today, 1), ctx.tz));
  const head = `☀️ *Bom dia!* Hoje é ${humanDatePt(today)}.`;
  const body = occ.length
    ? `Sua agenda:\n\n${formatAgenda(occ, today, today, ctx.tz)}`
    : "Agenda livre hoje ✨";

  // Peek at the next 3 days so nothing sneaks up.
  const next = await ctx.store.findOccurrences(localToUtc(addDays(today, 1), ctx.tz),
    localToUtc(addDays(today, 4), ctx.tz),
  );
  const peek = next.length
    ? `\n\n👀 *Próximos dias*\n${next
        .slice(0, 6)
        .map((o) => {
          const d = localDate(o.start, ctx.tz) < addDays(today, 1) ? addDays(today, 1) : localDate(o.start, ctx.tz);
          return `${capitalize(humanDatePt(d).split(",")[0]!)}: ${formatLine(o, d, ctx.tz)}`;
        })
        .join("\n")}`
    : "";
  return `${head}\n${body}${peek}`;
}

export async function eveningDigest(ctx: Ctx, tomorrow: string): Promise<string> {
  const occ = await ctx.store.findOccurrences(localToUtc(tomorrow, ctx.tz),
    localToUtc(addDays(tomorrow, 1), ctx.tz),
  );
  if (!occ.length) return `🌙 Amanhã (${humanDatePt(tomorrow)}) tá livre. Boa noite! ✨`;
  return `🌙 *Prévia de amanhã*\n\n${formatAgenda(occ, tomorrow, tomorrow, ctx.tz)}`;
}

function humanMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
}
