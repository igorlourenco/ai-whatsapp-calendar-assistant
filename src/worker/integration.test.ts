import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { memoryStore } from "./calendar/memory-store";
import * as schema from "./db/schema";
import { processInbox } from "./inbox";
import { HELP_TEXT, executeActions, handleMessage, type AppCtx } from "./llm/execute";
import { buildPrompt, extractActions, type Action } from "./llm/extract";
import { loadState, saveState, type State } from "./llm/state";
import { nextWakeUp, runDue } from "./notifications";
import { memoryDb } from "./testing/sqlite";
import { localDateTime, localToUtc } from "./time";

const TZ = "America/Araguaina";
const store = memoryStore(TZ, 30, [
  { slug: "faculdade", name: "Faculdade", emoji: "🎓", description: "aulas, provas, trabalhos e compromissos acadêmicos" },
  { slug: "trabalho", name: "Trabalho", emoji: "💼", description: "emprego, reuniões" },
  { slug: "pessoal", name: "Pessoal", emoji: "🏠", description: "todo o resto", isDefault: true },
]);
let ctx: AppCtx;

beforeAll(async () => {
  ctx = { store, db: await memoryDb(), tz: TZ, defaultReminder: 30 };
});

const exec = async (actions: Action[], sourceMessageId?: string) =>
  (await executeActions({ ...ctx, sourceMessageId }, actions)).reply;
const create = (a: Partial<Extract<Action, { type: "create" }>>): Action => ({
  type: "create",
  title: "X",
  date: "2026-12-01",
  ...a,
});
const byTitle = async (title: string) => store.all().filter((r) => r.title === title);

describe("executor (code builds every reply from the DB)", () => {
  it("create timed → confirmation rendered from the saved row", async () => {
    const reply = await exec([
      create({ title: "Dentista", date: "2026-11-20", start_time: "15:00", category: "pessoal", location: "Centro" }),
    ]);
    expect(reply).toBe(
      "✅ *Salvo na agenda*\n🏠 *Dentista*\n🗓️ sexta, 20 de novembro · 15:00–16:00\n📍 Centro\n⏰ lembrete 30 min antes",
    );
    expect(await byTitle("Dentista")).toHaveLength(1);
  });

  it("create multi-day all-day and weekly recurring", async () => {
    expect(await exec([create({ title: "Viagem", date: "2026-11-20", last_date: "2026-11-22" })])).toContain(
      "🗓️ 20/11 a 22/11 · dia todo",
    );
    const r = await exec([
      create({
        title: "Cálculo II",
        date: "2026-11-16",
        start_time: "19:00",
        end_time: "22:00",
        category: "faculdade",
        recurrence: { freq: "weekly", byWeekday: [1, 3], until: "2026-12-16" },
      }),
    ]);
    expect(r).toContain("🔁 toda semana (seg, qua) até 16/12");
  });

  it("query renders agenda; empty range says so", async () => {
    const r = await exec([{ type: "query", from: "2026-11-20", to: "2026-11-20" }]);
    expect(r).toContain("🏠 *15:00–16:00* Dentista · 📍 Centro");
    expect(r).toContain("_(dia 1/3)_");
    expect(await exec([{ type: "query", from: "2027-06-01", to: "2027-06-01" }])).toBe("🗓️ *Terça, 1 de junho*\nNada marcado ✨");
    expect(await exec([{ type: "query", from: "2027-06-01", to: "2027-06-07" }])).toBe("🗓️ Nada marcado de 01/06 a 07/06 ✨");
  });

  it("delete only one occurrence of a recurring event", async () => {
    const r = await exec([{ type: "delete", search: "calculo", on_date: "2026-11-18", only_that_day: true }]);
    expect(r).toBe("🗑️ *Cancelado* só em 18/11: Cálculo II");
    const week = await exec([{ type: "query", from: "2026-11-16", to: "2026-11-22", category: "faculdade" }]);
    expect(week.match(/Cálculo II/g)).toHaveLength(1);
  });

  it("update merges partial time and keeps duration", async () => {
    const r = await exec([{ type: "update", search: "dentista", changes: { start_time: "16:30" } }]);
    expect(r).toContain("✏️ *Atualizado*");
    expect(r).toContain("sexta, 20 de novembro · 16:30–17:30");
  });

  it("ambiguous or missing target changes nothing and says so", async () => {
    await exec([create({ title: "Reunião A", start_time: "09:00" }), create({ title: "Reunião B", date: "2026-12-02", start_time: "09:00" })]);
    const amb = await exec([{ type: "delete", search: "reuniao" }]);
    expect(amb).toMatch(/^❓ Achei 2 eventos com “reuniao”\. Qual deles\? \(responde com o número\)\n1\. .*Reunião A.*\n2\. .*Reunião B/);
    expect((await byTitle("Reunião A")).length + (await byTitle("Reunião B")).length).toBe(2);
    expect(await exec([{ type: "update", search: "piscina", changes: { start_time: "10:00" } }])).toBe(
      "❓ Não achei nenhum evento com “piscina”. Nada foi alterado.",
    );
  });

  it("unknown category never blocks the save (falls back to Pessoal, like iCloud)", async () => {
    const r = await exec([create({ title: "Yoga", start_time: "07:00", category: "academia" })]);
    expect(r).toMatch(/^✅ \*Salvo na agenda\*\n🏠 \*Yoga\*/);
  });

  it("invalid input → ❌ and nothing saved", async () => {
    const r = await exec([create({ title: "Errado", date: "2026-12-10", last_date: "2026-12-05" })]);
    expect(r).toBe("❌ A data final ficou antes da inicial. Nada foi salvo.");
    expect(await byTitle("Errado")).toHaveLength(0);
  });

  it("several actions in one message, in order", async () => {
    const r = await exec([
      create({ title: "Almoço João", date: "2026-12-03", start_time: "12:30" }),
      { type: "query", from: "2026-12-03", to: "2026-12-03" },
    ]);
    const [confirm, agenda] = r.split("\n\n");
    expect(confirm).toMatch(/^✅ \*Salvo na agenda\*\n🏠 \*Almoço João\*/);
    expect(agenda).toBe("🗓️ *Quinta, 3 de dezembro*\n🏠 *12:30–13:30* Almoço João");
  });

  it("create never duplicates: same message retried, or same event sent again", async () => {
    const a = create({ title: "Idem", date: "2026-12-04", start_time: "08:00" });
    await exec([a], "MSG-1");
    await exec([a], "MSG-1");
    expect(await byTitle("Idem")).toHaveLength(1);
    // Same title + same start from another message is a duplicate too.
    expect(await exec([a], "MSG-2")).toMatch(/^ℹ️ \*Já estava na agenda\*/);
    expect(await byTitle("Idem")).toHaveLength(1);
  });

  it("unknown", async () => {
    expect(await exec([{ type: "unknown" }])).toBe(HELP_TEXT);
  });
});

describe("structured context (draft + focus), never a transcript", () => {
  let state: State = { draft: null, focus: [] };
  const step = async (actions: Action[]) => {
    const r = await executeActions(ctx, actions, state);
    state = r.state;
    return r.reply;
  };

  it("missing date → asks, saves nothing, keeps a draft; next message completes it", async () => {
    expect(await step([create({ title: "Oftalmo", date: null, start_time: "15:00" })])).toBe("❓ *Oftalmo*: qual dia?");
    expect(await byTitle("Oftalmo")).toHaveLength(0);
    expect(state.draft).toMatchObject({ title: "Oftalmo", start_time: "15:00" });

    // The model sees the draft and emits a full create
    const r = await step([create({ title: "Oftalmo", date: "2026-12-11", start_time: "15:00" })]);
    expect(r).toMatch(/^✅ \*Salvo na agenda\*\n🏠 \*Oftalmo\*\n🗓️ sexta, 11 de dezembro · 15:00–16:00/);
    expect(state.draft).toBeNull();
    expect(state.focus[0]!.label).toBe("Oftalmo — sexta 11/12 15:00");
  });

  it("an unrelated message drops the draft", async () => {
    await step([create({ title: "Pilates", date: null })]);
    expect(state.draft).not.toBeNull();
    await step([{ type: "query", from: "2026-12-11", to: "2026-12-11" }]);
    expect(state.draft).toBeNull();
  });

  it("'muda pra 16h' via ref E1 updates the focused event", async () => {
    await step([create({ title: "Barbeiro", date: "2026-12-12", start_time: "10:00" })]);
    const r = await step([{ type: "update", ref: "E1", changes: { start_time: "16:00" } }]);
    expect(r).toContain("✏️ *Atualizado*\n🏠 *Barbeiro*\n🗓️ sábado, 12 de dezembro · 16:00–17:00");
  });

  it("model re-creating a focus event does not duplicate", async () => {
    const r = await step([create({ title: "Barbeiro", date: "2026-12-12", start_time: "16:00" })]);
    expect(r.startsWith("ℹ️ *Já estava na agenda*")).toBe(true);
    expect(await byTitle("Barbeiro")).toHaveLength(1);
  });

  it("ambiguity list becomes the focus: 'o 2' → E2", async () => {
    await step([create({ title: "Lavar carro", date: "2026-12-13" }), create({ title: "Lavar roupa", date: "2026-12-14" })]);
    const q = await step([{ type: "delete", search: "lavar" }]);
    expect(q).toContain("1. ");
    const r = await step([{ type: "delete", ref: "E2" }]);
    expect(r).toBe("🗑️ *Apagado:* Lavar roupa");
    expect(await byTitle("Lavar carro")).toHaveLength(1);
    expect(state.focus.map((f) => f.label)).not.toContain(expect.stringContaining("Lavar roupa"));
  });

  it("'qual deles?' remembers the pending update; the pick applies it", async () => {
    await step([create({ title: "Inglês", date: "2026-12-15", start_time: "18:00" }), create({ title: "Inglês", date: "2026-12-17", start_time: "18:00" })]);
    const q = await step([{ type: "update", search: "ingles", changes: { start_time: "19:00" } }]);
    expect(q).toMatch(/^❓ Achei 2 eventos/);
    expect(state.pick).toEqual({ action: "update", changes: { start_time: "19:00" } });
    const r = await step([{ type: "update", ref: "E2", changes: {} }]);
    expect(r).toContain("quinta, 17 de dezembro · 19:00–20:00");
    expect(state.pick).toBeNull();
    const untouched = (await byTitle("Inglês")).find((e) => localDateTime(e.startAt, TZ).startsWith("2026-12-15"))!;
    expect(localDateTime(untouched.startAt, TZ)).toBe("2026-12-15T18:00");
  });

  it("bad ref or no target → asks, changes nothing", async () => {
    expect(await step([{ type: "delete", ref: "E9" }])).toMatch(/^❓ Não sei qual evento/);
    expect(await step([{ type: "update", changes: { start_time: "09:00" } }])).toMatch(/^❓ Não sei qual evento/);
  });

  it("update with no changes asks what to change", async () => {
    expect(await step([{ type: "update", search: "barbeiro", changes: {} }])).toBe(
      "❓ Mudar o quê em *Barbeiro*? (dia, horário, nome, local, lembrete…)",
    );
  });

  it("state persists and expires", async () => {
    await saveState(ctx.db, { draft: { title: "Z" }, focus: state.focus }, new Date("2026-11-16T12:00:00Z"));
    const fresh = await loadState(ctx.db, new Date("2026-11-16T12:10:00Z"));
    expect(fresh.draft).toEqual({ title: "Z" });
    const later = await loadState(ctx.db, new Date("2026-11-16T12:20:00Z"));
    expect(later.draft).toBeNull(); // 15 min
    expect(later.focus.length).toBeGreaterThan(0); // 30 min
    expect((await loadState(ctx.db, new Date("2026-11-16T12:31:00Z"))).focus).toEqual([]);
  });
});

describe("extraction (stateless, JSON only)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { DEEPSEEK_API_KEY: "k" };
  const cats = [{ slug: "faculdade", emoji: "🎓", name: "Faculdade" }];

  function fakeModel(outputs: string[]) {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: outputs.shift() } }] }));
    });
    return bodies;
  }

  it("sends only system + this message, JSON mode, temperature 0", async () => {
    const bodies = fakeModel(['{"actions":[{"type":"unknown"}]}']);
    await extractActions(env, "oi", { now: new Date(), tz: TZ, categories: cats });
    expect(bodies[0].messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[0].temperature).toBe(0);
    expect(bodies[0].tools).toBeUndefined();
  });

  it("prompt carries only code-built context, never past replies", () => {
    const p = buildPrompt(new Date(), TZ, cats, {
      draft: { title: "Dentista", start_time: "15:00" },
      focus: [{ eventId: "x", occurrenceStart: new Date().toISOString(), label: "Barbeiro — sábado 12/12 16:00" }],
    });
    expect(p).toContain('{"title":"Dentista","start_time":"15:00"}');
    expect(p).toContain("E1 = Barbeiro — sábado 12/12 16:00");
    expect(p).not.toMatch(/Salvo na agenda|✅/);
  });

  it("retries once on malformed output, then throws (so the inbox retries/reports)", async () => {
    fakeModel(['{"actions":[{"type":"create"}]}', '{"actions":[{"type":"unknown"}]}']);
    expect(await extractActions(env, "x", { now: new Date(), tz: TZ, categories: cats })).toEqual([{ type: "unknown" }]);
    fakeModel(["nope", '{"actions":[]}']);
    await expect(extractActions(env, "x", { now: new Date(), tz: TZ, categories: cats })).rejects.toThrow();
  });

  it("end to end: the reply is the DB confirmation, nothing from the model's prose", async () => {
    fakeModel([
      JSON.stringify({
        actions: [{ type: "create", title: "Júri", date: "2026-11-16", start_time: "14:00", end_time: "17:00", category: "faculdade", reminder_minutes: null }],
      }),
    ]);
    const reply = await handleMessage(ctx, env, "hoje às 14h até as 17h tribunal do juri");
    expect(reply).toBe(
      "✅ *Salvo na agenda*\n🎓 *Júri*\n🗓️ segunda, 16 de novembro · 14:00–17:00\n⏰ lembrete 30 min antes",
    );
  });
});

describe("notifications", () => {
  const cfg = { morningAt: "07:00", eveningAt: "21:00" };

  it("sends reminder once and digests once", async () => {
    const sent: string[] = [];
    const send = async (m: string) => void sent.push(m);

    // Dentist at 16:30 with 30 min reminder → due 16:00
    await runDue(ctx, cfg, send, localToUtc("2026-11-20T16:02", TZ));
    await runDue(ctx, cfg, send, localToUtc("2026-11-20T16:07", TZ));
    expect(sent.filter((m) => m.startsWith("⏰"))).toHaveLength(1);
    expect(sent[0]).toContain("Daqui a 28 min");

    sent.length = 0;
    await runDue(ctx, cfg, send, localToUtc("2026-11-23T07:03", TZ));
    await runDue(ctx, cfg, send, localToUtc("2026-11-23T07:08", TZ));
    const morning = sent.filter((m) => m.includes("Bom dia"));
    expect(morning).toHaveLength(1);
    expect(morning[0]).toContain("Cálculo II");
    expect(morning[0]).toContain("Quarta: 🎓");

    sent.length = 0;
    await runDue(ctx, cfg, send, localToUtc("2026-11-19T21:01", TZ));
    expect(sent.find((m) => m.includes("Prévia de amanhã"))).toContain("Viagem");
  });

  it("occurrence query sanity", async () => {
    const occ = await ctx.store.findOccurrences(localToUtc("2026-11-21", TZ), localToUtc("2026-11-22", TZ));
    expect(occ.map((o) => o.event.title)).toEqual(["Viagem"]);
  });

  const wake = async (local: string) => localDateTime(await nextWakeUp(ctx, cfg, localToUtc(local, TZ)), TZ);

  it("nextWakeUp picks earliest of reminder and digest", async () => {
    expect(await wake("2026-11-23T10:00")).toBe("2026-11-23T18:30");
    expect(await wake("2026-11-23T18:40")).toBe("2026-11-23T18:40");
    expect(await wake("2026-11-20T16:10")).toBe("2026-11-20T21:00");
    expect(await wake("2026-11-21T22:00")).toBe("2026-11-22T07:00");
  });

  it("failed send releases the claim so a retry resends", async () => {
    const at = localToUtc("2026-11-25T18:31", TZ);
    await expect(
      runDue(ctx, cfg, async () => {
        throw new Error("zapi down");
      }, at),
    ).rejects.toThrow();
    const sent: string[] = [];
    await runDue(ctx, cfg, async (m) => void sent.push(m), at);
    await runDue(ctx, cfg, async (m) => void sent.push(m), at);
    expect(sent.filter((m) => m.includes("Cálculo II"))).toHaveLength(1);
  });
});

describe("durable inbox", () => {
  const enqueue = (id: string, text: string, at: string) =>
    ctx.db.insert(schema.inboundMessages).values({
      messageId: id, phone: "5511999998888", text, status: "pending", receivedAt: new Date(at), nextAttemptAt: new Date(at),
    });
  const status = async (id: string) =>
    (await ctx.db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.messageId, id)))[0]!;

  it("processes in order, retries with backoff, never re-runs the model for a send retry", async () => {
    await enqueue("IN-1", "primeira", "2026-11-16T13:00:00Z");
    await enqueue("IN-2", "segunda", "2026-11-16T13:00:01Z");
    let clock = Date.parse("2026-11-16T13:00:05Z");
    const handled: string[] = [];
    const sent: string[] = [];
    let failSend = true;
    const deps = {
      now: () => clock,
      handle: async (_c: AppCtx, text: string) => (handled.push(text), `resp:${text}`),
      send: async (_p: string, m: string) => {
        if (failSend) throw new Error("zapi 503");
        sent.push(m);
      },
    };

    await processInbox(ctx, deps);
    expect((await status("IN-1")).status).toBe("answered");
    expect((await status("IN-2")).status).toBe("pending");
    expect(handled).toEqual(["primeira"]);

    failSend = false;
    await processInbox(ctx, deps); // still in backoff
    expect(sent).toEqual([]);

    clock += 16_000;
    await processInbox(ctx, deps);
    expect(handled).toEqual(["primeira", "segunda"]);
    expect(sent).toEqual(["resp:primeira", "resp:segunda"]);
    expect((await status("IN-2")).status).toBe("done");
  });

  it("after max attempts the user is told what was and wasn't saved; retries don't duplicate", async () => {
    await enqueue("IN-3", "salva Reunião X amanhã 9h e Y", "2026-11-16T14:00:00Z");
    let clock = Date.parse("2026-11-16T14:00:01Z");
    const sent: string[] = [];
    const deps = {
      now: () => clock,
      handle: async (c: AppCtx) => {
        await executeActions(c, [create({ title: "Reunião X", date: "2026-11-17", start_time: "09:00" })]);
        await executeActions(c, [create({ title: "Reunião X", date: "2026-11-17", start_time: "09:00" })]);
        throw new Error("DeepSeek 500");
      },
      send: async (_p: string, m: string) => void sent.push(m),
    };
    for (let i = 0; i < 3; i++) {
      await processInbox(ctx, deps);
      clock += 61_000;
    }
    expect((await status("IN-3")).status).toBe("failed");
    expect(await byTitle("Reunião X")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Não consegui processar");
    expect(sent[0]).toContain("Isto chegou a ser salvo:\n• Reunião X — 2026-11-17 09:00");
  });
});
