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
import { shoppingItems, tasks as tasksTable } from "../src/worker/db/schema";
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
  | { kind: "query"; replyLike: RegExp }
  | { kind: "task_create"; titleLike: RegExp; due: string | null; time?: string; repeats?: boolean }
  | { kind: "task_update"; titleLike: RegExp; due: string; time?: string }
  | { kind: "task_done"; titleLike: RegExp }
  | { kind: "task_list"; replyLike: RegExp }
  /** Shopping list: open item names afterwards (lowercase, any order). */
  | { kind: "shop"; open: string[]; replyLike?: RegExp };

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
  { msg: "dia 28 tenho que pagar o boleto da faculdade", expect: { kind: "task_create", titleLike: /boleto/i, due: dayN(28) } },
  { msg: "almoço com o joão quinta 12h30", expect: { kind: "create", start: `${next(4)}T12:30`, allDay: false } },
  { msg: "o que eu tenho amanhã?", expect: { kind: "query", replyLike: /reuni[aã]o/i } },
  { msg: "hoje 20h jantar com a Ana", expect: { kind: "create", start: `${today}T20:00`, allDay: false } },
  { msg: "muda o jantar com a Ana pra 21h", expect: { kind: "update", titleLike: /jantar/i, start: `${today}T21:00` } },
  { msg: "cancela a academia", expect: { kind: "delete", titleLike: /academia/i } },
  // tasks (to-dos) vs events
  { msg: "me lembra de ligar pro banco amanhã às 10h", expect: { kind: "task_create", titleLike: /banco/i, due: addDays(today, 1), time: "10:00" } },
  // every task needs a date: asks, then the answer completes it
  { msg: "me lembra de comprar ração do cachorro", expect: { kind: "ask" } },
  { msg: "amanhã", expect: { kind: "task_create", titleLike: /ra[cç][aã]o/i, due: addDays(today, 1) } },
  { msg: "pagar aluguel todo dia 5", expect: { kind: "task_create", titleLike: /aluguel/i, due: dayN(5), repeats: true } },
  // sorted by due (date-only first on the same day): ração, banco (amanhã 10h), boleto (28), aluguel (5)
  { msg: "tarefas", expect: { kind: "task_list", replyLike: /ra[cç][aã]o[\s\S]*banco[\s\S]*boleto[\s\S]*aluguel/i } },
  { msg: "feito o 1", expect: { kind: "task_done", titleLike: /ra[cç][aã]o/i } },
  { msg: "adia o banco pra sexta", expect: { kind: "task_update", titleLike: /banco/i, due: next(5), time: "10:00" } },
  { msg: "paguei o boleto da faculdade", expect: { kind: "task_done", titleLike: /boleto/i } },
  // shopping list: no date → list; dated purchase stays a task
  { msg: "compra leite, ovos e pão", expect: { kind: "shop", open: ["leite", "ovos", "pão"] } },
  { msg: "acabou o café, põe na lista", expect: { kind: "shop", open: ["leite", "ovos", "pão", "café"] } },
  { msg: "o que falta comprar?", expect: { kind: "shop", open: ["leite", "ovos", "pão", "café"], replyLike: /leite[\s\S]*caf[eé]/i } },
  { msg: "comprei o leite e os ovos", expect: { kind: "shop", open: ["pão", "café"] } },
  { msg: "tira o café da lista", expect: { kind: "shop", open: ["pão"] } },
  { msg: "comprar presente da Ana até sexta", expect: { kind: "task_create", titleLike: /presente/i, due: next(5) } },
  { msg: "comprei tudo", expect: { kind: "shop", open: [] } },
  { msg: "dentista quarta 14h", expect: { kind: "create", start: `${next(3)}T14:00`, allDay: false } },
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

type TaskRow = typeof tasksTable.$inferSelect;
const taskSnap = async (ctx: AppCtx) => new Map(((await ctx.db.select().from(tasksTable)) as TaskRow[]).map((t) => [t.id, t]));
const shopSnap = async (ctx: AppCtx) =>
  JSON.stringify(((await ctx.db.select().from(shoppingItems)) as { name: string; status: string }[]).map((i) => [i.name, i.status]));
const openShop = async (ctx: AppCtx) =>
  ((await ctx.db.select().from(shoppingItems)) as { name: string; status: string }[]).filter((i) => i.status === "open").map((i) => i.name.toLowerCase()).sort();

function check(
  exp: Expect,
  before: Map<string, any>,
  after: Map<string, any>,
  reply: string,
  tb: Map<string, TaskRow>,
  ta: Map<string, TaskRow>,
  shop: string[],
): string | null {
  const added = [...after.values()].filter((e) => !before.has(e.id));
  const removed = [...before.values()].filter((e) => !after.has(e.id));
  const confirmed = reply.startsWith("✅") || reply.startsWith("✏️") || reply.startsWith("🗑️");
  const newTasks = [...ta.values()].filter((t) => !tb.has(t.id));
  const changedTasks = [...ta.values()].filter((t) => tb.has(t.id) && JSON.stringify(tb.get(t.id)) !== JSON.stringify(t));
  if (exp.kind.startsWith("task") && (added.length || removed.length)) return `task message touched events (+${added.length}/-${removed.length})`;
  if (!exp.kind.startsWith("task") && exp.kind !== "query" && (newTasks.length || changedTasks.length)) return `event message touched tasks`;
  if (exp.kind === "shop") {
    if (added.length || removed.length) return "shopping message touched events";
    const want = [...exp.open].map((x) => x.toLowerCase()).sort();
    if (JSON.stringify(shop) !== JSON.stringify(want)) return `open items ${JSON.stringify(shop)} ≠ ${JSON.stringify(want)}`;
    if (exp.replyLike && !exp.replyLike.test(reply)) return "reply doesn't show expected items";
    return null;
  }

  switch (exp.kind) {
    case "task_create": {
      if (newTasks.length !== 1) return `expected 1 new task, got ${newTasks.length}`;
      const t = newTasks[0]!;
      if (!exp.titleLike.test(t.title)) return `task title "${t.title}"`;
      if (t.dueDate !== exp.due) return `due ${t.dueDate} ≠ ${exp.due}`;
      if ((t.dueTime ?? undefined) !== exp.time) return `time ${t.dueTime} ≠ ${exp.time}`;
      if (!!exp.repeats !== !!t.recurrence) return `recurrence ${JSON.stringify(t.recurrence)}`;
      if (!reply.startsWith("📝")) return "task saved but reply lacks 📝";
      return null;
    }
    case "task_update": {
      if (newTasks.length) return "update created a task";
      const t = changedTasks.find((x) => exp.titleLike.test(x.title));
      if (!t) return "task to update not changed";
      if (t.dueDate !== exp.due || (exp.time && t.dueTime !== exp.time)) return `due ${t.dueDate} ${t.dueTime} ≠ ${exp.due} ${exp.time ?? ""}`;
      if (!reply.startsWith("✏️")) return "updated but reply lacks ✏️";
      return null;
    }
    case "task_done": {
      const done = changedTasks.filter((x) => x.status === "done");
      if (done.length !== 1 || !exp.titleLike.test(done[0]!.title)) return `expected 1 matching done, got ${done.map((d) => d.title)}`;
      if (!reply.startsWith("✅ *Feito")) return "done but reply lacks ✅ Feito";
      return null;
    }
    case "task_list":
      if (newTasks.length || changedTasks.length) return "list changed tasks";
      if (!exp.replyLike.test(reply)) return "list doesn't show expected tasks in order";
      return null;
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
    const tb = await taskSnap(ctx);
    const sb = await shopSnap(ctx);
    let reply = "";
    let fail: string | null;
    try {
      reply = await handleMessage({ ...ctx, sourceMessageId: `eval-${r}-${i}` }, env, c.msg);
      fail = check(c.expect, before, await snapshot(ctx), reply, tb, await taskSnap(ctx), await openShop(ctx));
    } catch (err) {
      fail = `threw: ${err instanceof Error ? err.message : err}`;
    }
    const after = await snapshot(ctx);
    const ta = await taskSnap(ctx);
    const changed =
      after.size !== before.size ||
      [...after.values()].some((e) => JSON.stringify(before.get(e.id)) !== JSON.stringify(e)) ||
      ta.size !== tb.size ||
      sb !== (await shopSnap(ctx)) ||
      [...ta.values()].some((t) => JSON.stringify(tb.get(t.id)) !== JSON.stringify(t));
    // The one unacceptable outcome: reply says it wrote, database says it didn't.
    const falseClaim = /^(✅|✏️|🗑️|📝 \*Tarefa anotada)/.test(reply) && !changed;
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
