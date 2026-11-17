import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { matchTitles } from "./calendar/store";
import { memoryStore } from "./calendar/memory-store";
import { tasks } from "./db/schema";
import { executeActions, guardDeletes, type AppCtx } from "./llm/execute";
import type { Action } from "./llm/extract";
import type { State } from "./llm/state";
import { memoryDb } from "./testing/sqlite";
import { localDateTime, localToUtc } from "./time";

/*
 * Real conversation: an event "Doação de sangue" and a task "Organizar doação
 * de suprimentos". The model mixed them up and wrote "doar" for "doação".
 */
const TZ = "America/Araguaina";
let ctx: AppCtx;
let state: State = { draft: null, focus: [] };

const step = async (actions: Action[]) => {
  const r = await executeActions(ctx, actions, state);
  state = r.state;
  return r.reply;
};
const eventStart = async () => {
  const [o] = await ctx.store.findOccurrences(localToUtc("2026-11-17", TZ), localToUtc("2026-11-20", TZ));
  return o ? localDateTime(o.start, TZ) : null;
};
const task = async () => (await ctx.db.select().from(tasks))[0]!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(localToUtc("2026-11-17T09:00", TZ));
  ctx = {
    store: memoryStore(TZ, 30, [{ slug: "pessoal", name: "Pessoal", emoji: "🏠", isDefault: true }]),
    db: await memoryDb(),
    tz: TZ,
    defaultReminder: 30,
  };
  await step([
    { type: "create", title: "Doação de sangue", date: "2026-11-18", start_time: "11:00" },
    { type: "create_task", title: "Organizar doação de suprimentos com a Giovana", due_date: "2026-11-17", due_time: "10:00" },
  ]);
});
afterAll(() => vi.useRealTimers());

describe("matchTitles", () => {
  const stop = new Set(["de"]);
  const titles = ["Doação de sangue", "Organizar doação de suprimentos", "Pagode", "Pagamento do aluguel"];
  const find = (q: string) => matchTitles(titles, (t) => t, q, stop);

  it("same root when no exact match: doar ~ doação, pagar ~ pagamento", () => {
    expect(find("doar sangue")).toEqual(["Doação de sangue"]);
    expect(find("pagar aluguel")).toEqual(["Pagamento do aluguel"]);
  });
  it("exact substring still wins over roots", () => {
    expect(find("doação")).toEqual(["Doação de sangue", "Organizar doação de suprimentos"]);
    expect(find("pagode")).toEqual(["Pagode"]);
  });
  it("short words don't fuzz", () => {
    expect(find("pag")).toEqual(["Pagode", "Pagamento do aluguel"]);
    expect(find("doa sangue")).toEqual(["Doação de sangue"]);
    expect(find("xyz")).toEqual([]);
  });
});

describe("task/event mix-ups", () => {
  it("event search with a verb instead of the noun (“doar sangue”) finds it", async () => {
    await step([{ type: "update", search: "doar sangue", changes: { start_time: "10:00" } }]);
    expect(await eventStart()).toBe("2026-11-18T10:00");
  });

  it("update_task naming an event (no task matches) updates the event", async () => {
    const reply = await step([{ type: "update_task", search: "doação de sangue", changes: { due_time: "09:00" } }]);
    expect(reply).toContain("Doação de sangue");
    expect(await eventStart()).toBe("2026-11-18T09:00");
    expect((await task()).dueTime).toBe("10:00");
  });

  it("update naming a task (no event matches) updates the task", async () => {
    await step([{ type: "update", search: "suprimentos", changes: { date: "2026-11-19", start_time: "15:00" } }]);
    expect(await task()).toMatchObject({ dueDate: "2026-11-19", dueTime: "15:00" });
    expect(await eventStart()).toBe("2026-11-18T09:00");
  });

  it("delete_task naming an event deletes the event", async () => {
    await step([{ type: "delete_task", search: "sangue" }]);
    expect(await eventStart()).toBeNull();
    expect(await ctx.db.select().from(tasks)).toHaveLength(1);
  });
});

describe("guardDeletes", () => {
  const del: Action = { type: "delete", search: "doação de sangue" };
  const upd: Action = { type: "update_task", ref: "T1", changes: { due_date: "2026-11-17" } };

  it("a correction never deletes", () => {
    const r = guardDeletes("não mano, era a doação de sangue, o evento", [del, upd]);
    expect(r.actions).toEqual([upd]);
    expect(r.blocked[0]).toContain("Nada foi apagado");
  });
  it("answer to a pending “which one to delete?” passes", () => {
    const pick = { draft: null, focus: [], pick: { action: "delete" as const } };
    expect(guardDeletes("a de quinta", [{ type: "delete", ref: "E2" }], pick).actions).toHaveLength(1);
  });
  it("explicit delete words pass", () => {
    for (const t of ["cancela a doação", "apaga isso", "Não vou mais na doação", "esquece o boleto", "desmarca"]) {
      expect(guardDeletes(t, [del]).actions).toEqual([del]);
    }
  });
});
