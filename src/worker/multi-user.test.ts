import ICAL from "ical.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sqliteStore } from "./calendar/sqlite-store";
import { profile } from "./db/schema";
import { buildFeed } from "./icloud/ics";
import { executeActions, type AppCtx } from "./llm/execute";
import type { Action } from "./llm/extract";
import type { State } from "./llm/state";
import { memoryDb } from "./testing/sqlite";
import { localDateTime, localToUtc } from "./time";
import { addUser, findUser, findUserByToken, listUsers, loadProfile, removeUser, setupGuest, userSettings } from "./users";
import { canonPhone } from "./zapi";

const TZ = "America/Araguaina";

describe("phones", () => {
  it("canonPhone: one key per BR mobile, with or without the 9th digit", () => {
    expect(canonPhone("+55 63 99104-7668")).toBe("556391047668");
    expect(canonPhone("556391047668")).toBe("556391047668");
    expect(canonPhone("+1 415 555 0100")).toBe("14155550100");
  });

});

describe("registry", () => {
  it("add is idempotent per number; token finds the user; remove", async () => {
    const db = await memoryDb();
    const a = await addUser(db, "+55 63 99104-7668", "Ana");
    const again = await addUser(db, "556391047668", "Ana B");
    expect(again).toEqual(a);
    expect(a.icsToken).toMatch(/^[a-f0-9]{40}$/);
    expect((await findUser(db, "5563991047668"))?.name).toBe("Ana");
    expect((await findUserByToken(db, a.icsToken))?.phone).toBe("556391047668");
    expect(await findUserByToken(db, "nope")).toBeNull();
    expect(await listUsers(db)).toHaveLength(1);
    expect(await removeUser(db, "556391047668")).toBe(true);
    expect(await findUser(db, "556391047668")).toBeNull();
  });
});

describe("guest profile and settings", () => {
  const env = { TIMEZONE: "America/Sao_Paulo", MORNING_DIGEST_TIME: "07:00", DEFAULT_REMINDER_MINUTES: "30" };

  it("setupGuest: local storage, starter categories once, feed url refreshed on rejoin", async () => {
    const db = await memoryDb();
    await setupGuest(db, "5563991047668", "Ana", "webcal://x/cal/1.ics");
    await setupGuest(db, "5563991047668", "Ana", "webcal://x/cal/2.ics");
    const p = await loadProfile(db);
    expect(p).toMatchObject({ phone: "5563991047668", storage: "local", feedUrl: "webcal://x/cal/2.ics" });
    const store = sqliteStore(db, TZ, 30);
    expect((await store.listCategories()).map((c) => c.slug)).toEqual(["estudos", "pessoal", "trabalho"]);
  });

  it("userSettings: profile overrides env, null falls back", async () => {
    const db = await memoryDb();
    expect(userSettings(env, null)).toMatchObject({ tz: "America/Sao_Paulo", morningAt: "07:00", defaultReminder: 30 });
    await db.insert(profile).values({ id: 1, tz: "Europe/Lisbon", morningAt: "08:30", defaultReminder: 0 });
    expect(userSettings(env, await loadProfile(db))).toMatchObject({ tz: "Europe/Lisbon", morningAt: "08:30", eveningAt: "21:00", defaultReminder: 0 });
  });
});

describe("guest flows on the SQLite store", () => {
  let ctx: AppCtx;
  let state: State = { draft: null, focus: [] };
  const step = async (actions: Action[], sourceMessageId?: string) => {
    const r = await executeActions({ ...ctx, sourceMessageId }, actions, state);
    state = r.state;
    return r.reply;
  };
  const store = () => ctx.store as ReturnType<typeof sqliteStore>;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(localToUtc("2026-11-18T09:00", TZ));
    const db = await memoryDb();
    await setupGuest(db, "5563991047668", "Ana", "webcal://bot.example/cal/abc.ics");
    ctx = {
      store: sqliteStore(db, TZ, 30),
      db,
      tz: TZ,
      defaultReminder: 30,
      user: { guest: true, feedUrl: "webcal://bot.example/cal/abc.ics", morningAt: "07:00", eveningAt: "21:00" },
    };
  });
  afterAll(() => vi.useRealTimers());

  it("create (idempotent per message), category, default reminder", async () => {
    const create: Action = { type: "create", title: "Dentista", date: "2026-11-20", start_time: "15:00", category: "pessoal" };
    expect(await step([create], "m1")).toBe(
      "✅ *Salvo na agenda*\n🏠 *Dentista*\n🗓️ sexta, 20 de novembro · 15:00–16:00\n⏰ lembrete 30 min antes",
    );
    await step([create], "m1");
    expect(await store().allRows()).toHaveLength(1);
  });

  it("update by name, then query", async () => {
    await step([{ type: "update", search: "dentista", changes: { start_time: "16:30" } }]);
    const [row] = await store().allRows();
    expect(localDateTime(row!.startAt, TZ)).toBe("2026-11-20T16:30");
    expect(await step([{ type: "query", from: "2026-11-20", to: "2026-11-20" }])).toContain("16:30–17:30");
  });

  it("recurring class: cancel one day keeps the series", async () => {
    await step([{ type: "create", title: "Inglês", date: "2026-11-19", start_time: "19:00", recurrence: { freq: "weekly", byWeekday: [4] }, category: "estudos" }], "m2");
    await step([{ type: "delete", search: "inglês", on_date: "2026-11-26", only_that_day: true }]);
    const occ = await ctx.store.findOccurrences(localToUtc("2026-11-18", TZ), localToUtc("2026-12-05", TZ), { query: "ingles" });
    expect(occ.map((o) => localDateTime(o.start, TZ))).toEqual(["2026-11-19T19:00", "2026-12-03T19:00"]);
  });

  it("create a category, then use it", async () => {
    await step([{ type: "create_category", name: "Academia", emoji: "🏋️" }, { type: "create", title: "Treino", date: "2026-11-21", category: "academia" }], "m3");
    const ev = (await store().allRows()).find((r) => r.title === "Treino")!;
    expect((await ctx.store.getEvent(ev.id))?.category?.slug).toBe("academia");
  });

  it("delete the whole event", async () => {
    expect(await step([{ type: "delete", search: "treino" }])).toBe("🗑️ *Apagado:* Treino");
  });

  it("settings: change, then show", async () => {
    expect(await step([{ type: "settings", morning_at: "08:00", reminder_minutes: 15 }])).toBe(
      "⚙️ *Configuração salva*\n☀️ resumo do dia: 08:00\n🌙 prévia de amanhã: 21:00\n⏰ lembrete padrão: 15 min antes\n🔔 cobrança de tarefas: desligada (_me cobra a cada 30 min_ liga)\n💸 gastos do dia: 22:30 · semana (dom) e mês (último dia) às 22:30\n🌎 fuso: America/Araguaina",
    );
    expect(await loadProfile(ctx.db)).toMatchObject({ morningAt: "08:00", defaultReminder: 15, storage: "local" });
    expect(await step([{ type: "settings", timezone: "Marte/Olympus" }])).toContain("Não reconheci o fuso");
  });

  it("settings: task nags off by default; turned on (min 5) and off by message", async () => {
    expect(userSettings({}, null).taskNagMinutes).toBe(0);
    expect(await step([{ type: "settings", task_nag_minutes: 20 }])).toContain("🔔 cobrança de tarefas: a cada 20 min");
    expect(userSettings({}, await loadProfile(ctx.db)).taskNagMinutes).toBe(20);
    await step([{ type: "settings", task_nag_minutes: 2 }]);
    expect((await loadProfile(ctx.db))?.taskNagMinutes).toBe(5);
    expect(await step([{ type: "settings", task_nag_minutes: 0 }])).toContain("🔔 cobrança de tarefas: desligada");
    expect(userSettings({ TASK_NAG_MINUTES: "30" }, await loadProfile(ctx.db)).taskNagMinutes).toBe(0);
  });

  it("calendar link: guest gets the feed; owner is told it's iCloud", async () => {
    expect(await step([{ type: "calendar_link" }])).toContain("webcal://bot.example/cal/abc.ics");
    const owner = await executeActions({ ...ctx, user: undefined }, [{ type: "calendar_link" }]);
    expect(owner.reply).toContain("iCloud");
  });

  it("ICS feed: every event, recurrence + EXDATE, alarm, category; parses back", async () => {
    const rows = await store().allRows();
    const cats = await ctx.store.listCategories();
    const ics = buildFeed(
      "Agenda · Ana",
      rows.map((r) => ({
        uid: `${r.id}@x`,
        title: r.title,
        start: r.startAt,
        end: r.endAt,
        allDay: r.allDay,
        recurrence: r.recurrence,
        reminderMinutes: r.reminderMinutes,
        exdates: r.exdates,
        category: cats.find((c) => c.id === r.categoryId)?.name,
      })),
      TZ,
    );
    expect(ics).toContain("X-WR-CALNAME:Agenda · Ana");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
    expect(ics).toContain("EXDATE:20261126T190000");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("CATEGORIES:Estudos");
    const vevents = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents("vevent");
    expect(vevents.map((v) => v.getFirstPropertyValue("summary")).sort()).toEqual(["Dentista", "Inglês"]);
  });
});
