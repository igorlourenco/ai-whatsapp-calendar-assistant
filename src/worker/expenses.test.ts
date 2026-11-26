import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStore } from "./calendar/memory-store";
import { expenses, shoppingItems } from "./db/schema";
import { brl, monthRange, weekRange } from "./expenses";
import { executeActions, guardDeletes, type AppCtx } from "./llm/execute";
import { buildPrompt, type Action } from "./llm/extract";
import { loadState, type State } from "./llm/state";
import { runDue } from "./notifications";
import { memoryDb } from "./testing/sqlite";
import { localToUtc } from "./time";
import { loadProfile } from "./users";

const TZ = "America/Araguaina";
let ctx: AppCtx;
let state: State = { draft: null, focus: [] };

const step = async (actions: Action[], sourceMessageId?: string) => {
  const r = await executeActions({ ...ctx, sourceMessageId }, actions, state);
  state = r.state;
  return r.reply;
};
const spend = (amount: number, description: string, category: string | null, extra: Partial<Extract<Action, { type: "add_expense" }>> = {}): Action => ({
  type: "add_expense",
  amount,
  description,
  category,
  ...extra,
});
const rows = () => ctx.db.select().from(expenses);
const fresh = async () => {
  ctx = { ...ctx, db: await memoryDb() };
  state = { draft: null, focus: [] };
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Thursday.
  vi.setSystemTime(localToUtc("2026-11-26T10:00", TZ));
  ctx = {
    store: memoryStore(TZ, 30, [{ slug: "pessoal", name: "Pessoal", emoji: "🏠", isDefault: true }]),
    db: await memoryDb(),
    tz: TZ,
    defaultReminder: 30,
  };
});
afterAll(() => vi.useRealTimers());

describe("helpers", () => {
  it("formats BRL", () => {
    expect(brl(4550)).toBe("R$ 45,50");
    expect(brl(123456789)).toBe("R$ 1.234.567,89");
    expect(brl(5)).toBe("R$ 0,05");
  });
  it("month and week ranges", () => {
    expect(monthRange("2026-11-26")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(monthRange("2026-12-05")).toEqual(["2026-12-01", "2026-12-31"]);
    expect(monthRange("2028-02-10")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(weekRange("2026-11-26")).toEqual(["2026-11-23", "2026-11-29"]);
    expect(weekRange("2026-11-29")).toEqual(["2026-11-23", "2026-11-29"]);
  });
  it("migration seeds the categories, Dates included; prompt lists them and past periods", async () => {
    const { listExpenseCategories } = await import("./expenses");
    const cats = await listExpenseCategories(ctx.db);
    expect(cats.map((c) => c.slug)).toEqual(
      expect.arrayContaining(["alimentacao", "mercado", "transporte", "moradia", "contas", "saude", "lazer", "compras", "assinaturas", "educacao", "dates", "outros"]),
    );
    expect(cats.find((c) => c.isDefault)?.slug).toBe("outros");
    const p = buildPrompt(new Date(), TZ, [], state, cats);
    expect(p).toContain("- dates (💘 Dates)");
    expect(p).toContain("2026-11-25 = quarta, 25 de novembro (ontem)");
    expect(p).toContain("Esta semana: 2026-11-23 a 2026-11-26");
    expect(p).toContain("mês passado: 2026-10-01 a 2026-10-31");
  });
});

describe("logging", () => {
  beforeEach(fresh);

  it("logs today by default; a retried message isn't logged twice", async () => {
    const a = spend(45, "ifood", "alimentacao");
    expect(await step([a], "m1")).toBe("💸 *Anotado*: R$ 45,00 · 🍔 Alimentação\nIfood · hoje");
    await step([a], "m1");
    expect(await rows()).toMatchObject([{ amount: 4500, description: "Ifood", category: "alimentacao", spentOn: "2026-11-26" }]);
  });

  it("several in one message, cents kept; unknown category → Outros", async () => {
    const r = await step([spend(23.5, "Uber", "transporte"), spend(10, "Chaveiro", "inventada")], "m2");
    expect(r).toContain("R$ 23,50 · 🚗 Transporte");
    expect(r).toContain("R$ 10,00 · 📦 Outros");
    expect((await rows()).map((e) => e.amount).sort()).toEqual([1000, 2350]);
  });

  it("dates category and a past day", async () => {
    expect(await step([spend(150, "Jantar do date", "dates", { date: "2026-11-25" })], "m3")).toBe(
      "💸 *Anotado*: R$ 150,00 · 💘 Dates\nJantar do date · ontem",
    );
  });

  it("future date is refused", async () => {
    expect(await step([spend(50, "Luz", "contas", { date: "2026-11-30" })], "m4")).toContain("❌ Gasto não pode ser numa data futura");
    expect(await rows()).toHaveLength(0);
  });

  it("checks the purchased items off the shopping list", async () => {
    await step([{ type: "add_shopping", items: ["leite", "pão", "café"] }], "s1");
    const r = await step([spend(15, "Padaria", "mercado", { shopping_items: ["leite", "pão", "manteiga"] })], "m5");
    expect(r).toContain("🛒 Tirei da lista: Leite e Pão · falta 1");
    expect((await ctx.db.select().from(shoppingItems)).filter((i) => i.status === "open").map((i) => i.name)).toEqual(["Café"]);
  });
});

describe("fixing and deleting", () => {
  beforeAll(async () => {
    await fresh();
    await step([spend(45, "iFood", "alimentacao")], "f1");
    await step([spend(23, "Uber", "transporte", { date: "2026-11-24" })], "f2");
    await step([spend(18, "Uber", "transporte")], "f3");
  });

  it("“na verdade foi 50” → G1 is the last one logged", async () => {
    expect(state.expenses?.[0]?.label).toBe("Uber · R$ 18,00 · hoje (transporte)");
    expect(await step([{ type: "update_expense", ref: "G1", changes: { amount: 20 } }])).toBe(
      "✏️ *Gasto corrigido*: R$ 20,00 · 🚗 Transporte\nUber · hoje",
    );
  });

  it("move to another category; unknown category explains", async () => {
    expect(await step([{ type: "update_expense", search: "ifood", changes: { category: "dates" } }])).toContain("💘 Dates");
    expect(await step([{ type: "update_expense", ref: "G1", changes: { category: "pets" } }])).toContain("❌ Não tenho a categoria de gasto “pets”");
  });

  it("several matches → asks which, then the answer applies the same change", async () => {
    expect(await step([{ type: "update_expense", search: "uber", changes: { amount: 30 } }])).toBe(
      "❓ Achei 2 gastos com “uber”. Qual? (responde com o número)\n1. 🚗 Uber — R$ 20,00 · hoje\n2. 🚗 Uber — R$ 23,00 · ter 24/11",
    );
    expect(state.pick).toEqual({ action: "update_expense", changes: { amount: 30 } });
    expect(await step([{ type: "update_expense", ref: "G2", changes: {} }])).toBe("✏️ *Gasto corrigido*: R$ 30,00 · 🚗 Transporte\nUber · ter 24/11");
  });

  it("a value in the search narrows by amount", async () => {
    const { searchExpenses } = await import("./expenses");
    expect((await searchExpenses(ctx.db, "uber de 20", "2026-11-26")).map((e) => e.amount)).toEqual([2000]);
    expect((await searchExpenses(ctx.db, "uber R$ 30,00", "2026-11-26")).map((e) => e.amount)).toEqual([3000]);
    expect((await searchExpenses(ctx.db, "o de 45", "2026-11-26")).map((e) => e.description)).toEqual(["iFood"]);
    expect(await searchExpenses(ctx.db, "uber 99", "2026-11-26")).toEqual([]);
  });

  it("delete needs an explicit word; then deletes", async () => {
    const del: Action = { type: "delete_expense", ref: "G1" };
    expect(guardDeletes("foi 30", [del]).actions).toHaveLength(0);
    expect(guardDeletes("apaga esse", [del]).actions).toHaveLength(1);
    expect(await step([del])).toBe("🗑️ *Gasto apagado:* Uber — R$ 30,00 · ter 24/11");
    expect(await rows()).toHaveLength(2);
  });

  it("state survives a reload (G refs persisted)", async () => {
    const { saveState } = await import("./llm/state");
    await saveState(ctx.db, state);
    expect((await loadState(ctx.db)).expenses?.length).toBeGreaterThan(0);
  });
});

describe("queries", () => {
  beforeAll(async () => {
    await fresh();
    await step([spend(45, "iFood", "alimentacao"), spend(20, "Uber", "transporte"), spend(312, "Mercado", "mercado")], "q1");
    await step([spend(100, "Cinema", "dates", { date: "2026-11-20" })], "q2");
    await step([spend(1200, "Aluguel", "moradia", { date: "2026-11-05" })], "q3");
    await step([spend(80, "Bar", "lazer", { date: "2026-10-30" })], "q4");
  });

  it("today: each expense numbered (G refs)", async () => {
    expect(await step([{ type: "query_expenses", from: "2026-11-26", to: "2026-11-26" }])).toBe(
      "💸 *Gastos de hoje*: R$ 377,00 · 3 gastos\n1. 🛒 Mercado — R$ 312,00\n2. 🚗 Uber — R$ 20,00\n3. 🍔 iFood — R$ 45,00",
    );
    expect(state.lastList).toBe("expenses");
    expect(state.expenses?.[0]?.label).toContain("Mercado");
  });

  it("month: list + breakdown by category", async () => {
    const r = await step([{ type: "query_expenses", from: "2026-11-01", to: "2026-11-26" }]);
    expect(r).toContain("💸 *Gastos de novembro (até hoje)*: R$ 1.677,00 · 5 gastos");
    expect(r).toContain("🏠 Moradia: R$ 1.200,00 (72%)");
    expect(r).not.toContain("Bar");
  });

  it("one category", async () => {
    expect(await step([{ type: "query_expenses", from: "2026-11-01", to: "2026-11-26", category: "dates" }])).toBe(
      "💸 *Gastos de novembro (até hoje) · 💘 Dates*: R$ 100,00\n1. 💘 Cinema — R$ 100,00",
    );
  });

  it("nothing in the period", async () => {
    expect(await step([{ type: "query_expenses", from: "2026-11-21", to: "2026-11-22" }])).toBe("💸 Gastos de 21/11 a 22/11: nenhum gasto ✨");
  });
});

describe("limits", () => {
  beforeAll(fresh);

  it("set a category limit; shown with progress", async () => {
    await step([spend(500, "Restaurante", "alimentacao", { date: "2026-11-10" })], "b0");
    expect(await step([{ type: "set_budget", category: "alimentação", amount: 800 }])).toBe(
      "📊 *Limite de 🍔 Alimentação:* R$ 800,00 por mês\n📊 🍔 Alimentação em novembro: R$ 500,00 de R$ 800,00 (63%)\n_Aviso quando chegar em 80% e quando estourar._",
    );
  });

  it("warns from 80%, then when it blows", async () => {
    expect(await step([spend(150, "iFood", "alimentacao")], "b1")).toBe(
      "💸 *Anotado*: R$ 150,00 · 🍔 Alimentação\niFood · hoje\n📊 🍔 Alimentação em novembro: R$ 650,00 de R$ 800,00 (81%)\n⚠️ Restam R$ 150,00",
    );
    expect(await step([spend(200, "Churrascaria", "alimentacao")], "b2")).toContain("🚨 *Limite estourado* em R$ 50,00");
  });

  it("an expense from last month doesn't count in this month's limit", async () => {
    expect(await step([spend(100, "Pizza", "alimentacao", { date: "2026-10-31" })], "b3")).toContain("em outubro: R$ 100,00 de R$ 800,00 (13%)");
  });

  it("overall limit: stored in the profile, shown from 80%", async () => {
    expect(await step([{ type: "set_budget", category: null, amount: 1000 }])).toBe(
      "📊 *Limite total:* R$ 1.000,00 por mês\n📊 💰 Total em novembro: R$ 850,00 de R$ 1.000,00 (85%)\n⚠️ Restam R$ 150,00",
    );
    expect((await loadProfile(ctx.db))?.expenseBudget).toBe(100000);
    expect(await step([spend(10, "Café", "lazer")], "b4")).toContain("💰 Total em novembro: R$ 860,00");
  });

  it("list and remove", async () => {
    const list = await step([{ type: "list_budgets" }]);
    expect(list).toContain("🚨 🍔 Alimentação: R$ 850,00 de R$ 800,00 (106%)");
    expect(list).toContain("⚠️ 💰 Total: R$ 860,00 de R$ 1.000,00 (86%)");
    expect(await step([{ type: "set_budget", category: "alimentacao", amount: 0 }])).toBe("🗑️ Limite de 🍔 Alimentação removido.");
    expect(await step([{ type: "list_budgets" }])).not.toContain("Alimentação");
  });

  it("new category, then a limit for it", async () => {
    expect(await step([{ type: "create_expense_category", name: "pet", emoji: "🐶" }])).toBe("🏷️ Categoria de gasto criada: 🐶 Pet");
    expect(await step([{ type: "create_expense_category", name: "Pet", emoji: "🐕" }])).toBe("ℹ️ Já existe a categoria de gasto 🐶 Pet");
    expect(await step([spend(90, "Ração", "pet")], "b5")).toContain("🐶 Pet");
  });
});

describe("summaries at 22:30", () => {
  const sent: string[] = [];
  // Only the spending summaries (agenda digests also go out in these ticks).
  const send = async (m: string) => void (/^(💸|📅|🗓️)/u.test(m) && sent.push(m));
  const cfg = { morningAt: "07:00", eveningAt: "21:00" };
  const tick = (local: string, c: Parameters<typeof runDue>[1] = cfg) => runDue(ctx, c, send, localToUtc(local, TZ));

  beforeAll(async () => {
    await fresh();
    await step([spend(45, "iFood", "alimentacao"), spend(20, "Uber", "transporte")], "d1");
    await step([spend(100, "Cinema", "dates", { date: "2026-11-23" })], "d2");
    await step([spend(60, "Farmácia", "saude", { date: "2026-11-17" })], "d3");
  });
  beforeEach(() => void (sent.length = 0));

  it("daily: list + month so far, once; G refs for corrections", async () => {
    await tick("2026-11-26T22:00");
    expect(sent.filter((m) => m.includes("Gastos de hoje"))).toHaveLength(0);
    await tick("2026-11-26T22:30");
    await tick("2026-11-26T22:45");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(
      "💸 *Gastos de hoje (26/11)*: R$ 65,00 · 2 gastos\n1. 🚗 Uber — R$ 20,00\n2. 🍔 iFood — R$ 45,00\n\n_No mês: R$ 225,00_\n_Errado? manda_ *muda o 2 pra 30* _ou_ *apaga o 1*",
    );
    const st = await loadState(ctx.db);
    expect(st.lastList).toBe("expenses");
    expect(st.expenses?.[0]?.label).toContain("Uber");
  });

  it("no expenses that day → nothing", async () => {
    await tick("2026-11-27T22:30");
    expect(sent).toHaveLength(0);
  });

  it("turned off by message: no daily", async () => {
    expect(await step([{ type: "settings", expense_daily: false }])).toContain("💸 gastos do dia: desligado");
    expect((await loadProfile(ctx.db))?.expenseDaily).toBe(false);
    await step([spend(10, "Pão", "mercado", { date: "2026-11-26" })], "d4");
    vi.setSystemTime(localToUtc("2026-11-28T10:00", TZ));
    await step([spend(10, "Pão", "mercado")], "d5");
    await tick("2026-11-28T22:30", { ...cfg, expenseDaily: false });
    expect(sent).toHaveLength(0);
    await step([{ type: "settings", expense_daily: true, expense_at: "23:00" }]);
    expect((await loadProfile(ctx.db))?.expenseAt).toBe("23:00");
  });

  it("Sunday: week summary with comparison", async () => {
    await tick("2026-11-29T22:30", { ...cfg, expenseDaily: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(
      "📅 *Resumo da semana* (23/11 a 29/11)\nTotal: *R$ 185,00* · média R$ 26,43/dia · gastou em 3 de 7 dias\n↑ 208% vs semana passada (R$ 60,00)\n\n💘 Dates: R$ 100,00 (54%)\n🍔 Alimentação: R$ 45,00 (24%)\n🚗 Transporte: R$ 20,00 (11%)\n🛒 Mercado: R$ 20,00 (11%)",
    );
  });

  it("last day of the month: month summary", async () => {
    await step([{ type: "set_budget", category: "dates", amount: 90 }]);
    await tick("2026-11-30T22:30", { ...cfg, expenseDaily: false, expenseBudget: 20000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("🗓️ *Resumo de novembro*\nTotal: *R$ 245,00* · 6 gastos\n🚨 limite total: 123% de R$ 200,00");
    expect(sent[0]).toContain("💘 Dates: R$ 100,00 (41%) · 🚨 111% de R$ 90,00");
    expect(sent[0]).toContain("🔝 *Maiores gastos*\n1. 💘 Cinema — R$ 100,00 · 23/11");
  });
});
