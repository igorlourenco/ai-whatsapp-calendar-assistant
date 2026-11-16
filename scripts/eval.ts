/**
 * End-to-end eval against the REAL DeepSeek model, on a throwaway in-memory
 * store + SQLite (sql.js). Never touches iCloud or WhatsApp.
 *
 *   pnpm eval            # 3 rounds
 *   pnpm eval 5          # 5 rounds
 *
 * Each round replays the messages in order on one database (updates/deletes
 * depend on earlier creates) and checks the database after every message.
 */

import { memoryStore } from "../src/worker/calendar/memory-store";
import { handleMessage, type AppCtx } from "../src/worker/llm/execute";
import { memoryDb } from "../src/worker/testing/sqlite";
import { addDays, localDate, localDateTime, weekdayOf } from "../src/worker/time";

const TZ = "America/Araguaina";
const ROUNDS = Number(process.argv[2] ?? 3);
const env = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY!, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL };

const today = localDate(new Date(), TZ);
/** Next given weekday strictly after today (0=Sun). */
const next = (wd: number) => addDays(today, ((wd - weekdayOf(today) + 7) % 7) || 7);
/** Day N of this month, or next month if already past. */
const dayN = (n: number) => {
  const d = `${today.slice(0, 8)}${String(n).padStart(2, "0")}`;
  if (d >= today) return d;
  const [y, m] = today.split("-").map(Number);
  const nm = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
  return `${nm}-${String(n).padStart(2, "0")}`;
};
const yearOf = (mmdd: string) => (`${today.slice(0, 4)}-${mmdd}` >= today ? today.slice(0, 4) : String(Number(today.slice(0, 4)) + 1));

type Ev = ReturnType<ReturnType<typeof memoryStore>["all"]>[number];
type Expect =
  | { kind: "create"; start: string; allDay: boolean; lastDay?: string; weekly?: number[]; category?: string }
  | { kind: "update"; titleLike: RegExp; start?: string; reminder?: number }
  | { kind: "delete"; titleLike: RegExp; removedStart?: string }
  | { kind: "ask" }
  | { kind: "query"; replyLike: RegExp };

const CASES: { msg: string; expect: Expect }[] = [
  { msg: "hoje às 14h até as 17h tenho que ir ver o tribunal do juri do meu professor", expect: { kind: "create", start: `${today}T14:00`, allDay: false, category: "faculdade" } },
  { msg: "dia 19 tenho depilacao a laser na barba, 9h30", expect: { kind: "create", start: `${dayN(19)}T09:30`, allDay: false } },
  { msg: "amanhã reunião com o time às 10", expect: { kind: "create", start: `${addDays(today, 1)}T10:00`, allDay: false, category: "trabalho" } },
  // context: follow-up without naming the event
  { msg: "muda pra 11h", expect: { kind: "update", titleLike: /reuni/i, start: `${addDays(today, 1)}T11:00` } },
  { msg: "prova de penal sexta", expect: { kind: "create", start: next(5), allDay: true, category: "faculdade" } },
  { msg: "viagem pra são paulo de 20 a 23 de dezembro", expect: { kind: "create", start: `${yearOf("12-20")}-12-20`, allDay: true, lastDay: `${yearOf("12-20")}-12-23` } },
  { msg: "aula de processo civil toda terça e quinta das 19h às 22h", expect: { kind: "create", start: "T19:00", allDay: false, weekly: [2, 4], category: "faculdade" } },
  { msg: "academia segunda que vem 7h", expect: { kind: "create", start: `${next(1)}T07:00`, allDay: false } },
  { msg: "me lembra 1h antes", expect: { kind: "update", titleLike: /academia/i, reminder: 60 } },
  // context: incomplete → question → completion
  { msg: "marca oftalmologista", expect: { kind: "ask" } },
  { msg: "dia 10 às 15h", expect: { kind: "create", start: `${dayN(10)}T15:00`, allDay: false } },
  // draft dropped by an unrelated request
  { msg: "marca pilates", expect: { kind: "ask" } },
  { msg: "o que tenho hoje?", expect: { kind: "query", replyLike: /j[uú]ri/i } },
  // ambiguity → numbered question → pick by description
  { msg: "aula de inglês terça 18h", expect: { kind: "create", start: `${next(2)}T18:00`, allDay: false } },
  { msg: "aula de inglês quinta 18h", expect: { kind: "create", start: `${next(4)}T18:00`, allDay: false } },
  { msg: "cancela a aula de inglês", expect: { kind: "ask" } },
  { msg: "a de quinta", expect: { kind: "delete", titleLike: /ingl/i, removedStart: `${next(4)}T18:00` } },
  { msg: "aniversário da minha mãe dia 3 de janeiro", expect: { kind: "create", start: `${yearOf("01-03")}-01-03`, allDay: true } },
  { msg: "consulta no dermato 15/12 às 16h30", expect: { kind: "create", start: `${yearOf("12-15")}-12-15T16:30`, allDay: false } },
  { msg: "dia 28 tenho que pagar o boleto da faculdade", expect: { kind: "create", start: dayN(28), allDay: true } },
  { msg: "almoço com o joão quinta 12h30", expect: { kind: "create", start: `${next(4)}T12:30`, allDay: false } },
  { msg: "o que eu tenho amanhã?", expect: { kind: "query", replyLike: /reuni[aã]o/i } },
  { msg: "hoje 20h jantar com a Ana", expect: { kind: "create", start: `${today}T20:00`, allDay: false } },
  { msg: "muda o jantar com a Ana pra 21h", expect: { kind: "update", titleLike: /jantar/i, start: `${today}T21:00` } },
  { msg: "cancela a academia", expect: { kind: "delete", titleLike: /academia/i } },
];

type Store = ReturnType<typeof memoryStore>;

async function freshCtx(): Promise<AppCtx & { store: Store }> {
  const store = memoryStore(TZ, 30, [
    { slug: "faculdade", name: "Faculdade", emoji: "🎓", description: "aulas, provas, trabalhos e compromissos acadêmicos" },
    { slug: "trabalho", name: "Trabalho", emoji: "💼", description: "emprego, reuniões" },
    { slug: "pessoal", name: "Pessoal", emoji: "🏠", description: "todo o resto", isDefault: true },
  ]);
  return { store, db: await memoryDb(), tz: TZ, defaultReminder: 30 };
}

async function snapshot(ctx: AppCtx & { store: Store }): Promise<Map<string, Ev & { cat: string | null }>> {
  const cats = new Map((await ctx.store.listCategories()).map((c) => [c.id, c.slug]));
  // Copies, so later mutations don't leak into "before".
  return new Map(ctx.store.all().map((r) => [r.id, { ...structuredClone(r), cat: cats.get(r.categoryId ?? "") ?? null }]));
}

function check(exp: Expect, before: Map<string, any>, after: Map<string, any>, reply: string): string | null {
  const added = [...after.values()].filter((e) => !before.has(e.id));
  const removed = [...before.values()].filter((e) => !after.has(e.id));
  const confirmed = reply.startsWith("✅") || reply.startsWith("✏️") || reply.startsWith("🗑️");

  switch (exp.kind) {
    case "create": {
      if (added.length !== 1) return `expected 1 new event, got ${added.length}`;
      const e = added[0];
      const start = localDateTime(e.startAt, TZ);
      const startOk = exp.start.startsWith("T") ? start.endsWith(exp.start.slice(1)) : exp.allDay ? start.startsWith(exp.start) : start === exp.start;
      if (!startOk) return `start ${start} ≠ ${exp.start}`;
      if (e.allDay !== exp.allDay) return `allDay ${e.allDay} ≠ ${exp.allDay}`;
      if (exp.lastDay && localDate(new Date(e.endAt.getTime() - 1), TZ) !== exp.lastDay) return `lastDay wrong`;
      if (exp.weekly && JSON.stringify([...(e.recurrence?.byWeekday ?? [])].sort()) !== JSON.stringify(exp.weekly)) return `recurrence ${JSON.stringify(e.recurrence)}`;
      if (exp.category && e.cat !== exp.category) return `category ${e.cat} ≠ ${exp.category} (soft)`;
      if (!reply.startsWith("✅")) return `saved but reply lacks ✅`;
      return null;
    }
    case "update": {
      if (added.length || removed.length) return `update changed event count (+${added.length}/-${removed.length})`;
      const e = [...after.values()].find((x) => exp.titleLike.test(x.title));
      if (!e) return "event to update not found";
      if (exp.start && localDateTime(e.startAt, TZ) !== exp.start) return `updated start ${localDateTime(e.startAt, TZ)} ≠ ${exp.start}`;
      if (exp.reminder !== undefined && e.reminderMinutes !== exp.reminder) return `reminder ${e.reminderMinutes} ≠ ${exp.reminder}`;
      if (!reply.startsWith("✏️")) return "updated but reply lacks ✏️";
      return null;
    }
    case "delete": {
      if (removed.length !== 1 || !exp.titleLike.test(removed[0].title)) return `expected 1 matching delete, got ${removed.map((r) => r.title)}`;
      if (exp.removedStart && localDateTime(removed[0].startAt, TZ) !== exp.removedStart) return `deleted the wrong one (${localDateTime(removed[0].startAt, TZ)})`;
      if (!reply.includes("🗑️")) return "deleted but reply lacks 🗑️";
      return null;
    }
    case "ask":
      if (added.length || removed.length) return `ask changed data (+${added.length}/-${removed.length})`;
      if (!reply.startsWith("❓")) return "expected a ❓ question";
      return null;
    case "query":
      if (added.length || removed.length) return "query changed data";
      if (confirmed) return "query reply looks like a write confirmation";
      if (!exp.replyLike.test(reply)) return `reply doesn't mention expected item`;
      return null;
  }
}

type Outcome = { round: number; i: number; msg: string; fail: string | null; reply: string; falseClaim: boolean };

async function round(r: number): Promise<Outcome[]> {
  const ctx = await freshCtx();
  const out: Outcome[] = [];
  for (const [i, c] of CASES.entries()) {
    const before = await snapshot(ctx);
    let reply = "";
    let fail: string | null;
    try {
      reply = await handleMessage({ ...ctx, sourceMessageId: `eval-${r}-${i}` }, env, c.msg);
      fail = check(c.expect, before, await snapshot(ctx), reply);
    } catch (err) {
      fail = `threw: ${err instanceof Error ? err.message : err}`;
    }
    const after = await snapshot(ctx);
    const changed = after.size !== before.size || [...after.values()].some((e) => JSON.stringify(before.get(e.id)) !== JSON.stringify(e));
    // The one unacceptable outcome: reply says it wrote, database says it didn't.
    const falseClaim = /^(✅|✏️|🗑️)/.test(reply) && !changed;
    out.push({ round: r, i, msg: c.msg, fail, reply, falseClaim });
    process.stdout.write(fail ? (fail.includes("(soft)") ? "~" : "✗") : "✓");
  }
  return out;
}

if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing (.dev.vars)");
console.log(`today=${today}  rounds=${ROUNDS}  cases=${CASES.length}\n`);
const results = (await Promise.all(Array.from({ length: ROUNDS }, (_, r) => round(r)))).flat();
console.log("\n");

const hard = results.filter((r) => r.fail && !r.fail.includes("(soft)"));
const soft = results.filter((r) => r.fail?.includes("(soft)"));
const falseClaims = results.filter((r) => r.falseClaim);
for (const f of [...hard, ...soft]) {
  console.log(`[r${f.round} #${f.i + 1}] ${f.msg}\n   → ${f.fail}\n   reply: ${f.reply.replace(/\n/g, " ⏎ ").slice(0, 220)}\n`);
}
console.log(`correct: ${results.length - hard.length - soft.length}/${results.length}`);
console.log(`wrong interpretation (hard): ${hard.length}`);
console.log(`wrong category only (soft): ${soft.length}`);
console.log(`FALSE "saved" claims: ${falseClaims.length}  ← must be 0`);
process.exit(falseClaims.length ? 1 : 0);
