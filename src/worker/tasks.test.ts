import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { memoryStore } from "./calendar/memory-store";
import { tasks } from "./db/schema";
import { executeActions, type AppCtx } from "./llm/execute";
import type { Action } from "./llm/extract";
import { buildPrompt } from "./llm/extract";
import { loadState, type State } from "./llm/state";
import { morningDigest, nextWakeUp, runDue } from "./notifications";
import { nextDue, openTasks } from "./tasks";
import { memoryDb } from "./testing/sqlite";
import { localDateTime, localToUtc } from "./time";

const TZ = "America/Araguaina";
const cfg = { morningAt: "07:00", eveningAt: "21:00" };
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
  };
});
afterAll(() => vi.useRealTimers());

describe("tasks", () => {
  it("create: dated with time, undated; confirmation re-read from the DB", async () => {
    expect(await step([task({ title: "Pagar boleto", due_date: "2026-11-20", due_time: "10:00" })], "m1")).toBe(
      "📝 *Tarefa anotada*\n*Pagar boleto*\n🗓️ sexta, 20 de novembro · ⏰ aviso às 10:00",
    );
    expect(await step([task({ title: "Comprar presente" })], "m2")).toBe(
      "📝 *Tarefa anotada*\n*Comprar presente*\n🗓️ sem prazo",
    );
    expect(state.tasks?.[0]?.label).toBe("Comprar presente");
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
      "📝 *Tarefas* (2)\n1. Pagar boleto — sex 20/11 10:00\n2. Comprar presente\n\n_Responda “feito 1”, “adia o 2 pra sexta”…_",
    );
    expect(state.lastList).toBe("tasks");
    expect(await step([{ type: "complete_task", ref: "T2" }])).toBe("✅ *Feito:* Comprar presente");
    expect((await openTasks(ctx.db)).map((t) => t.title)).toEqual(["Pagar boleto"]);
    expect(await step([{ type: "list_tasks" }])).toContain("(1)");
  });

  it("update by name: 'adia o boleto pra segunda' keeps the time and re-arms the nag", async () => {
    const r = await step([{ type: "update_task", search: "boleto", changes: { due_date: "2026-11-23" } }]);
    expect(r).toBe("✏️ *Tarefa atualizada*\n*Pagar boleto*\n🗓️ segunda, 23 de novembro · ⏰ aviso às 10:00");
  });

  it("ambiguous name → numbered question; the pick applies the pending action", async () => {
    await step([task({ title: "Ligar pro banco" }), task({ title: "Ligar pra mãe" })], "m4");
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

describe("task notifications", () => {
  it("nag once at the due time; it becomes T1 so a bare 'feito' works", async () => {
    const sent: string[] = [];
    const send = async (m: string) => void sent.push(m);
    expect(localDateTime(await nextWakeUp(ctx, cfg, localToUtc("2026-11-23T08:00", TZ)), TZ)).toBe("2026-11-23T10:00");

    await runDue(ctx, cfg, send, localToUtc("2026-11-23T09:59", TZ));
    expect(sent.filter((m) => m.includes("Tarefa:"))).toHaveLength(0);
    await runDue(ctx, cfg, send, localToUtc("2026-11-23T10:00", TZ));
    await runDue(ctx, cfg, send, localToUtc("2026-11-23T10:05", TZ));
    const nags = sent.filter((m) => m.includes("Tarefa:"));
    expect(nags).toEqual(["⏰ *Tarefa:* Pagar boleto\n_Responda *feito* ou *adia pra …*_"]);

    const s = await loadState(ctx.db, localToUtc("2026-11-23T10:05", TZ));
    expect(s.tasks?.[0]?.label).toMatch(/^Pagar boleto/);
    expect(s.lastList).toBe("tasks");
  });

  it("failed send releases the nag", async () => {
    await step([task({ title: "Mandar email", due_date: "2026-11-24", due_time: "08:00" })], "m7");
    const at = localToUtc("2026-11-24T08:01", TZ);
    await expect(runDue(ctx, cfg, async () => { throw new Error("zapi down"); }, at)).rejects.toThrow();
    const sent: string[] = [];
    await runDue(ctx, cfg, async (m) => void sent.push(m), at);
    expect(sent.filter((m) => m.startsWith("⏰ *Tarefa:* Mandar email"))).toHaveLength(1);
  });

  it("morning digest lists today's and overdue tasks", async () => {
    const d = await morningDigest(ctx, "2026-11-16");
    expect(d).toContain("📝 *Tarefas pra hoje*\n• Renovar CNH — ⚠️ atrasada (ter 10/11)");
  });
});
