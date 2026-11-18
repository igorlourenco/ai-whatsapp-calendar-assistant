import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { memoryStore } from "./calendar/memory-store";
import { tasks } from "./db/schema";
import { executeActions, type AppCtx } from "./llm/execute";
import type { Action } from "./llm/extract";
import { buildPrompt } from "./llm/extract";
import { loadState, type State } from "./llm/state";
import { morningDigest, nextWakeUp, runDue } from "./notifications";
import { nextDue, nextNagAt, openTasks } from "./tasks";
import { memoryDb } from "./testing/sqlite";
import { localDateTime, localToUtc } from "./time";

const TZ = "America/Araguaina";
const cfg = { morningAt: "07:00", eveningAt: "21:00", taskNagMinutes: 30 };
let ctx: AppCtx;
let state: State = { draft: null, focus: [] };

const step = async (actions: Action[], sourceMessageId?: string) => {
  const r = await executeActions({ ...ctx, sourceMessageId }, actions, state);
  state = r.state;
  return r.reply;
};
const task = (a: Partial<Extract<Action, { type: "create_task" }>>): Action => ({ type: "create_task", title: "X", ...a });
const all = () => ctx.db.select().from(tasks);

beforeAll(async () => {
  // Monday 2026-11-16, 09:00 local.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(localToUtc("2026-11-16T09:00", TZ));
  ctx = {
    store: memoryStore(TZ, 30, [{ slug: "pessoal", name: "Pessoal", emoji: "🏠", isDefault: true }]),
    db: await memoryDb(),
    tz: TZ,
    defaultReminder: 30,
    taskNagMinutes: 30,
  };
});
afterAll(() => vi.useRealTimers());

describe("tasks", () => {
  it("create with date (+time); confirmation re-read from the DB", async () => {
    expect(await step([task({ title: "Pagar boleto", due_date: "2026-11-20", due_time: "10:00" })], "m1")).toBe(
      "📝 *Tarefa anotada*\n🏠 *Pagar boleto*\n🗓️ sexta, 20 de novembro · 10:00\n⏰ te cobro a cada 30 min a partir das 10:00 até você dizer *feito*",
    );
  });

  it("no date → asks 'pra quando?', saves nothing; the answer completes it", async () => {
    expect(await step([task({ title: "Comprar presente" })], "m2")).toBe(
      "❓ *Comprar presente*: pra quando? (ex: _hoje_, _sexta_, _amanhã 10h_)",
    );
    expect(await all()).toHaveLength(1);
    expect(state.draft).toMatchObject({ kind: "task", title: "Comprar presente" });
    expect(buildPrompt(new Date(), TZ, [], state)).toContain("Tarefa incompleta aguardando a data");

    expect(await step([task({ title: "Comprar presente", due_date: "2026-11-27" })], "m2b")).toBe(
      "📝 *Tarefa anotada*\n🏠 *Comprar presente*\n🗓️ sexta, 27 de novembro\n⏰ te cobro a cada 30 min até você dizer *feito*",
    );
    expect(state.draft).toBeNull();
    expect(state.tasks?.[0]?.label).toBe("Comprar presente — sex 27/11");
    expect(await all()).toHaveLength(2);
  });

  it("never duplicates: retried message or same task sent again", async () => {
    await step([task({ title: "Pagar boleto", due_date: "2026-11-20", due_time: "10:00" })], "m1");
    expect(await step([task({ title: "pagar boleto", due_date: "2026-11-20", due_time: "10:00" })], "m3")).toMatch(
      /^ℹ️ \*Já estava na lista\*/,
    );
    expect(await all()).toHaveLength(2);
  });

  it("list → numbered; 'feito o 2' resolves T2 from that list", async () => {
    const list = await step([{ type: "list_tasks" }]);
    expect(list).toBe(
      "📝 *Tarefas* (2)\n1. Pagar boleto — sex 20/11 10:00\n2. Comprar presente — sex 27/11\n\n_Responda “feito 1”, “adia o 2 pra sexta”…_",
    );
    expect(state.lastList).toBe("tasks");
    expect(await step([{ type: "complete_task", ref: "T2" }])).toBe("✅ *Feito:* Comprar presente");
    expect((await openTasks(ctx.db)).map((t) => t.title)).toEqual(["Pagar boleto"]);
    expect(await step([{ type: "list_tasks" }])).toContain("(1)");
  });

  it("update by name: 'adia o boleto pra segunda' keeps the time and re-arms the nag", async () => {
    const r = await step([{ type: "update_task", search: "boleto", changes: { due_date: "2026-11-23" } }]);
    expect(r).toMatch(/^✏️ \*Tarefa atualizada\*\n🏠 \*Pagar boleto\*\n🗓️ segunda, 23 de novembro · 10:00\n/);
  });

  it("ambiguous name → numbered question; the pick applies the pending action", async () => {
    await step([task({ title: "Ligar pro banco", due_date: "2026-11-25" }), task({ title: "Ligar pra mãe", due_date: "2026-11-26" })], "m4");
    const q = await step([{ type: "complete_task", search: "ligar" }]);
    expect(q).toMatch(/^❓ Achei 2 tarefas/);
    expect(state.pick).toEqual({ action: "complete_task" });
    expect(await step([{ type: "complete_task", ref: "T2" }])).toBe("✅ *Feito:* Ligar pra mãe");
    expect(await step([{ type: "complete_task", search: "zzz" }])).toMatch(/^❓ Não achei nenhuma tarefa/);
    expect(await step([{ type: "delete_task", ref: "T9" }])).toMatch(/^❓ Não sei qual tarefa/);
  });

  it("delete", async () => {
    expect(await step([{ type: "delete_task", search: "banco" }])).toBe("🗑️ *Tarefa apagada:* Ligar pro banco");
    expect((await all()).some((t) => t.title === "Ligar pro banco")).toBe(false);
  });

  it("repeating task: done moves it to the next date and stays open", async () => {
    expect(nextDue("2026-12-05", { freq: "monthly" }, TZ)).toBe("2027-01-05");
    expect(nextDue("2026-11-16", { freq: "weekly", byWeekday: [1, 4] }, TZ)).toBe("2026-11-19");
    expect(nextDue("2026-12-05", { freq: "monthly", until: "2026-12-31" }, TZ)).toBeNull();

    await step([task({ title: "Pagar aluguel", due_date: "2026-12-05", recurrence: { freq: "monthly" } })], "m5");
    const r = await step([{ type: "complete_task", search: "aluguel" }]);
    expect(r).toBe("✅ *Feito:* Pagar aluguel\n🔁 próxima: terça, 5 de janeiro");
    expect((await openTasks(ctx.db)).find((t) => t.title === "Pagar aluguel")?.dueDate).toBe("2027-01-05");
  });

  it("agenda query includes tasks due in the range (and overdue ones for today)", async () => {
    await step([task({ title: "Renovar CNH", due_date: "2026-11-10" })], "m6");
    const r = await step([{ type: "query", from: "2026-11-16", to: "2026-11-16" }]);
    expect(r).toContain("📝 *Tarefas*\n• Renovar CNH — ⚠️ atrasada (ter 10/11)");
    const later = await step([{ type: "query", from: "2026-11-23", to: "2026-11-23" }]);
    expect(later).toContain("• Pagar boleto — seg 23/11 10:00");
    expect(later).not.toContain("Renovar CNH");
  });

  it("prompt shows T refs and which numbered list was last", () => {
    const p = buildPrompt(new Date(), TZ, [], {
      draft: null,
      focus: [{ eventId: "e", occurrenceStart: new Date().toISOString(), label: "Dentista — sexta 20/11 15:00" }],
      tasks: [{ taskId: "t", label: "Pagar boleto — hoje" }],
      lastList: "tasks",
    });
    expect(p).toContain("T1 = Pagar boleto — hoje");
    expect(p).toContain("última lista numerada mostrada foi de TAREFAS");
  });
});

describe("task lists (categories)", () => {
  let lctx: AppCtx;
  let st: State = { draft: null, focus: [] };
  const run = async (actions: Action[], id?: string) => {
    const r = await executeActions({ ...lctx, sourceMessageId: id }, actions, st);
    st = r.state;
    return r.reply;
  };

  beforeAll(async () => {
    lctx = {
      ...ctx,
      db: await memoryDb(),
      store: memoryStore(TZ, 30, [
        { slug: "pessoal", name: "Pessoal", emoji: "🏠", isDefault: true },
        { slug: "trabalho", name: "Trabalho", emoji: "💼", isDefault: false },
        { slug: "estudos", name: "Estudos", emoji: "🎓", isDefault: false },
      ]),
    };
  });

  it("create picks the category; unknown/none → default", async () => {
    expect(await run([task({ title: "Entregar trabalho de penal", due_date: "2026-11-20", category: "estudos" })], "l1")).toMatch(
      /^📝 \*Tarefa anotada\*\n🎓 \*Entregar trabalho de penal\*/,
    );
    await run([task({ title: "Mandar relatório", due_date: "2026-11-16", due_time: "17:00", category: "Trabalho" })], "l2");
    await run([task({ title: "Trocar lâmpada", due_date: "2026-11-16", category: "zzz" })], "l3");
    await run([task({ title: "Ler cap. 3", due_date: "2026-11-17", category: "estudos" })], "l4");
    expect((await lctx.db.select().from(tasks)).map((t) => [t.title, t.category])).toEqual([
      ["Entregar trabalho de penal", "estudos"],
      ["Mandar relatório", "trabalho"],
      ["Trocar lâmpada", "pessoal"],
      ["Ler cap. 3", "estudos"],
    ]);
  });

  it("list groups by category with continuous numbering; refs follow it", async () => {
    // A task saved before categories existed shows up in the default group.
    await lctx.db.insert(tasks).values({ id: "old", title: "Pagar luz", dueDate: "2026-11-18" });
    expect(await run([{ type: "list_tasks" }])).toBe(
      "📝 *Tarefas* (5)\n🏠 *Pessoal*\n1. Trocar lâmpada — hoje\n2. Pagar luz — qua 18/11\n\n💼 *Trabalho*\n3. Mandar relatório — hoje 17:00\n\n🎓 *Estudos*\n4. Ler cap. 3 — amanhã\n5. Entregar trabalho de penal — sex 20/11\n\n_Responda “feito 1”, “adia o 2 pra sexta”…_",
    );
    expect(await run([{ type: "complete_task", ref: "T3" }])).toBe("✅ *Feito:* Mandar relatório");
  });

  it("one list only; empty and unknown lists", async () => {
    expect(await run([{ type: "list_tasks", category: "estudos" }])).toBe(
      "🎓 *Tarefas · Estudos* (2)\n1. Ler cap. 3 — amanhã\n2. Entregar trabalho de penal — sex 20/11\n\n_Responda “feito 1”, “adia o 2 pra sexta”…_",
    );
    expect(st.tasks?.[1]?.label).toBe("Entregar trabalho de penal — sex 20/11");
    expect(await run([{ type: "list_tasks", category: "trabalho" }])).toBe("💼 Nenhuma tarefa aberta em *Trabalho* ✨");
    expect(await run([{ type: "list_tasks", category: "academia" }])).toContain("Não tenho a lista “academia”");
  });

  it("move a task to another list", async () => {
    expect(await run([{ type: "update_task", search: "lâmpada", changes: { category: "trabalho" } }])).toMatch(/^✏️ \*Tarefa atualizada\*\n💼 \*Trocar lâmpada\*/);
    expect(await run([{ type: "update_task", search: "lâmpada", changes: { category: "academia" } }])).toContain("Não tenho a lista “academia”");
  });
});

describe("task nags off (the default)", () => {
  it("no nag line in the confirmation, and nothing is sent", async () => {
    const off: AppCtx = { ...ctx, db: await memoryDb(), taskNagMinutes: undefined };
    const r = await executeActions({ ...off, sourceMessageId: "off1" }, [task({ title: "Pagar luz", due_date: "2026-11-16", due_time: "10:00" })]);
    expect(r.reply).toBe("📝 *Tarefa anotada*\n🏠 *Pagar luz*\n🗓️ segunda, 16 de novembro · 10:00");
    const sent: string[] = [];
    const offCfg = { morningAt: "07:00", eveningAt: "21:00" };
    for (const t of ["10:00", "10:30", "11:00"]) await runDue(off, offCfg, async (m) => void sent.push(m), localToUtc(`2026-11-16T${t}`, TZ));
    expect(sent.filter((m) => m.startsWith("⏰ *Tarefa"))).toHaveLength(0);
    expect(localDateTime(await nextWakeUp(off, offCfg, localToUtc("2026-11-16T10:00", TZ)), TZ)).toBe("2026-11-16T21:00");
  });
});

describe("task nags: every 30 min until done", () => {
  let nctx: AppCtx;
  const sent: string[] = [];
  const send = async (m: string) => void sent.push(m);
  const nags = () => sent.filter((m) => m.startsWith("⏰ *Tarefa"));
  const at = (local: string) => localToUtc(local, TZ);
  const tick = (local: string) => runDue(nctx, cfg, send, at(local));

  beforeAll(async () => {
    nctx = { ...ctx, db: await memoryDb() };
    const r = await executeActions({ ...nctx, sourceMessageId: "n1" }, [
      task({ title: "Pagar boleto", due_date: "2026-11-23", due_time: "10:00" }),
      task({ title: "Renovar CNH", due_date: "2026-11-23" }),
    ]);
    expect(r.reply).toContain("Pagar boleto");
  });

  it("date-only task starts one interval after the morning digest, repeats every 30 min", async () => {
    expect(localDateTime(await nextWakeUp(nctx, cfg, at("2026-11-23T07:05")), TZ)).toBe("2026-11-23T07:30");
    await tick("2026-11-23T07:29");
    expect(nags()).toHaveLength(0);
    await tick("2026-11-23T07:30");
    await tick("2026-11-23T07:45");
    expect(nags()).toEqual(["⏰ *Tarefa pendente:* Renovar CNH — hoje\n_Já fez? Responda *feito* (ou *adia pra …*)_"]);
    expect(localDateTime(await nextWakeUp(nctx, cfg, at("2026-11-23T07:45")), TZ)).toBe("2026-11-23T08:00");
    await tick("2026-11-23T08:00");
    expect(nags()).toHaveLength(2);
  });

  it("when another becomes due, ONE message lists all pending (numbered = T refs)", async () => {
    sent.length = 0;
    await tick("2026-11-23T10:00");
    expect(nags()).toEqual([
      "⏰ *Tarefas pendentes* (2)\n1. Renovar CNH — hoje\n2. Pagar boleto — hoje 10:00\n_Responda *feito 1*, *feito todas* ou *adia o 2 pra amanhã*_",
    ]);
    const s = await loadState(nctx.db, at("2026-11-23T10:00"));
    expect(s.lastList).toBe("tasks");
    // "feito 2" right after the nag
    vi.setSystemTime(at("2026-11-23T10:01"));
    const r = await executeActions(nctx, [{ type: "complete_task", ref: "T2" }], s);
    expect(r.reply).toBe("✅ *Feito:* Pagar boleto");

    sent.length = 0;
    await tick("2026-11-23T10:30");
    expect(nags()).toEqual(["⏰ *Tarefa pendente:* Renovar CNH — hoje\n_Já fez? Responda *feito* (ou *adia pra …*)_"]);
  });

  it("quiet after 22:00; resumes next morning as overdue", async () => {
    sent.length = 0;
    await tick("2026-11-23T21:45");
    await tick("2026-11-23T22:15");
    await tick("2026-11-24T03:00");
    expect(nags()).toHaveLength(1);
    const open = await openTasks(nctx.db);
    expect(localDateTime(nextNagAt(open[0]!, { morningAt: "07:00", every: 30, until: "22:00" }, TZ, at("2026-11-24T03:00"))!, TZ)).toBe(
      "2026-11-24T07:30",
    );
    sent.length = 0;
    await tick("2026-11-24T07:30");
    expect(nags()[0]).toContain("Renovar CNH — ⚠️ atrasada (seg 23/11)");
  });

  it("failed send undoes the mark, so the retry sends", async () => {
    sent.length = 0;
    await expect(runDue(nctx, cfg, async () => { throw new Error("zapi down"); }, at("2026-11-24T08:00"))).rejects.toThrow();
    await tick("2026-11-24T08:00");
    expect(nags()).toHaveLength(1);
  });

  it("done stops the nagging", async () => {
    const s = await loadState(nctx.db, at("2026-11-24T08:00"));
    await executeActions(nctx, [{ type: "complete_task", ref: "T1" }], s);
    sent.length = 0;
    await tick("2026-11-24T09:00");
    expect(nags()).toHaveLength(0);
  });

  it("task timed after the quiet hour still gets one nag at its time", async () => {
    await executeActions({ ...nctx, sourceMessageId: "n2" }, [task({ title: "Tomar remédio", due_date: "2026-11-24", due_time: "23:00" })]);
    sent.length = 0;
    await tick("2026-11-24T23:00");
    await tick("2026-11-24T23:30");
    expect(nags()).toHaveLength(1);
  });

  it("morning digest lists today's and overdue tasks", async () => {
    const d = await morningDigest(ctx, "2026-11-16");
    expect(d).toContain("📝 *Tarefas pra hoje*\n• Renovar CNH — ⚠️ atrasada (ter 10/11)");
  });
});
