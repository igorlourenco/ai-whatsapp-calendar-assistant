import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { memoryStore } from "./calendar/memory-store";
import { shoppingItems, tasks } from "./db/schema";
import { executeActions, type AppCtx } from "./llm/execute";
import type { Action } from "./llm/extract";
import type { State } from "./llm/state";
import { memoryDb } from "./testing/sqlite";
import { localToUtc } from "./time";

const TZ = "America/Araguaina";
let ctx: AppCtx;
let state: State = { draft: null, focus: [] };

const step = async (actions: Action[], sourceMessageId?: string) => {
  const r = await executeActions({ ...ctx, sourceMessageId }, actions, state);
  state = r.state;
  return r.reply;
};
const rows = () => ctx.db.select().from(shoppingItems);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(localToUtc("2026-11-17T09:00", TZ));
  ctx = {
    store: memoryStore(TZ, 30, [{ slug: "pessoal", name: "Pessoal", emoji: "🏠", isDefault: true }]),
    db: await memoryDb(),
    tz: TZ,
    defaultReminder: 30,
  };
});
afterAll(() => vi.useRealTimers());

describe("shopping list", () => {
  it("empty list", async () => {
    expect(await step([{ type: "list_shopping" }])).toBe("🛒 Lista de compras vazia ✨");
  });

  it("adds several items, capitalized; a retried message doesn't duplicate", async () => {
    const add: Action = { type: "add_shopping", items: ["leite", "ovos", "pão", "leite condensado"] };
    expect(await step([add], "m1")).toBe(
      "🛒 *Na lista:* Leite, Ovos, Pão e Leite condensado\n_4 itens na lista · manda *lista* pra ver_",
    );
    await step([add], "m1");
    expect(await rows()).toHaveLength(4);
  });

  it("an item already open isn't added twice (accents/case ignored)", async () => {
    expect(await step([{ type: "add_shopping", items: ["PAO", "café"] }], "m2")).toBe(
      "🛒 *Na lista:* Café\nℹ️ Já estava na lista: Pão\n_5 itens na lista · manda *lista* pra ver_",
    );
  });

  it("lists open items in the order they were added", async () => {
    expect(await step([{ type: "list_shopping" }])).toBe(
      "🛒 *Lista de compras* (5)\n• Leite\n• Ovos\n• Pão\n• Leite condensado\n• Café",
    );
  });

  it("bought: exact name wins (“leite” isn't “leite condensado”); unknown items are reported", async () => {
    expect(await step([{ type: "bought", items: ["leite", "ovo", "manteiga"] }])).toBe(
      "✅ *Comprado:* Leite e Ovos\n❓ Não achei “manteiga” na lista.\n🛒 Falta: Pão, Leite condensado e Café",
    );
    expect((await rows()).filter((r) => r.status === "bought").map((r) => r.name)).toEqual(["Leite", "Ovos"]);
  });

  it("several partial matches → asks, changes nothing for that one", async () => {
    await step([{ type: "add_shopping", items: ["leite em pó"] }], "m3");
    expect(await step([{ type: "bought", items: ["leite"] }])).toBe(
      "❓ “leite” bate com Leite condensado e Leite em pó. Qual? (manda o nome inteiro)",
    );
  });

  it("remove without buying", async () => {
    expect(await step([{ type: "remove_shopping", items: ["leite em pó"] }])).toBe(
      "🗑️ *Tirado da lista:* Leite em pó\n🛒 Falta: Pão, Leite condensado e Café",
    );
    expect((await rows()).some((r) => r.name === "Leite em pó")).toBe(false);
  });

  it("bought everything", async () => {
    expect(await step([{ type: "bought", items: [], all: true }])).toBe(
      "✅ *Comprado:* Pão, Leite condensado e Café\n🛒 Lista zerada ✨",
    );
    expect(await step([{ type: "bought", all: true }])).toBe("🛒 A lista de compras já está vazia.");
  });

  it("re-adding a bought item makes it open again", async () => {
    await step([{ type: "add_shopping", items: ["leite"] }], "m4");
    expect(await step([{ type: "list_shopping" }])).toBe("🛒 *Lista de compras* (1)\n• Leite");
  });
});

describe("shopping vs tasks mix-ups", () => {
  it("complete_task for an item on the list → bought", async () => {
    expect(await step([{ type: "complete_task", search: "leite" }])).toContain("✅ *Comprado:* Leite");
  });

  it("bought naming a task (not on the list) → completes the task", async () => {
    await step([{ type: "create_task", title: "Comprar presente da Ana", due_date: "2026-11-20" }], "m5");
    expect(await step([{ type: "bought", items: ["presente da Ana"] }])).toBe("✅ *Feito:* Comprar presente da Ana");
    expect((await ctx.db.select().from(tasks))[0]?.status).toBe("done");
  });

  it("delete_task for an item on the list → removes it", async () => {
    await step([{ type: "add_shopping", items: ["detergente"] }], "m6");
    expect(await step([{ type: "delete_task", search: "detergente" }])).toBe("🗑️ *Tirado da lista:* Detergente\n🛒 Lista zerada ✨");
  });
});
