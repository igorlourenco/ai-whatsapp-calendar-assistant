/**
 * End-to-end voice-note eval with the REAL models: Workers AI Whisper (REST,
 * your wrangler login) → DeepSeek extraction → saved events / tasks / list.
 * In-memory store and SQLite: never touches iCloud or WhatsApp.
 *
 *   pnpm eval:audio        # 3 rounds
 *   pnpm eval:audio 5
 *
 * Fixtures: scripts/fixtures/audio, Ogg/Opus like WhatsApp voice notes,
 * synthesized with macOS `say` (pt-BR voices). Dates are absolute.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { memoryStore } from "../src/worker/calendar/memory-store";
import { settings } from "../src/worker/config";
import { handleMessage, type AppCtx } from "../src/worker/llm/execute";
import { normalizeSpeech, whisperInput, type Transcribe } from "../src/worker/llm/transcribe";
import { openItems } from "../src/worker/shopping";
import { openTasks } from "../src/worker/tasks";
import { memoryDb } from "../src/worker/testing/sqlite";
import { localDate, localDateTime } from "../src/worker/time";

const TZ = "America/Sao_Paulo";
const ROUNDS = Number(process.argv[2] ?? 3);
const env = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY!, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL };
const model = settings(process.env).transcribeModel;

// `wrangler auth token` prints a banner first: take the token line, not the ──── rule.
const token = execSync("npx wrangler auth token 2>/dev/null", { encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .find((l) => /^[\w.-]{30,}$/.test(l));
const account = execSync("npx wrangler whoami 2>/dev/null", { encoding: "utf8" }).match(/[0-9a-f]{32}/)?.[0];
if (!token || !account) throw new Error("run `npx wrangler login` first");

const transcribe: Transcribe = async (bytes) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(whisperInput(bytes)),
  });
  const j = (await r.json()) as { success: boolean; result?: { text?: string }; errors?: unknown };
  if (!j.success) throw new Error(`Workers AI: ${JSON.stringify(j.errors)}`);
  return normalizeSpeech(j.result?.text ?? "");
};

type Ctx = AppCtx & { store: ReturnType<typeof memoryStore> };
type Case = { file: string; check: (ctx: Ctx, reply: string) => Promise<string | null> };

const event =
  (title: RegExp, date: string, time: string, end?: string) =>
  async (ctx: Ctx): Promise<string | null> => {
    const all = ctx.store.all();
    const ev = all.find((s) => title.test(s.title) && localDate(s.startAt, TZ) === date);
    if (!ev || all.length !== 1) return `expected 1 event ${title} on ${date}, got: ${all.map((s) => `${s.title}@${localDateTime(s.startAt, TZ)}`).join(", ") || "none"}`;
    if (localDateTime(ev.startAt, TZ).slice(11) !== time) return `${ev.title}: start ${localDateTime(ev.startAt, TZ)} ≠ ${time}`;
    if (end && localDateTime(ev.endAt, TZ).slice(11) !== end) return `${ev.title}: end ${localDateTime(ev.endAt, TZ)} ≠ ${end}`;
    return null;
  };

const CASES: Case[] = [
  { file: "dentista.ogg", check: event(/dentista/i, "2026-11-25", "15:00") },
  { file: "reuniao.ogg", check: event(/reuni|cliente/i, "2026-12-01", "10:00", "12:00") },
  {
    file: "compras.ogg",
    check: async (ctx) => {
      const names = (await openItems(ctx.db)).map((i) => i.name.toLowerCase()).sort();
      return ["leite", "ovos", "pão"].every((n) => names.some((x) => x.includes(n))) && names.length === 3 ? null : `list: ${names.join(", ")}`;
    },
  },
  {
    file: "boleto.ogg",
    check: async (ctx) => {
      const tasks = await openTasks(ctx.db);
      const t = tasks.find((x) => /boleto/i.test(x.title));
      if (!t || tasks.length !== 1) return `tasks: ${tasks.map((x) => `${x.title}@${x.dueDate}`).join(", ") || "none"}`;
      return t.dueDate === "2026-11-30" ? null : `${t.title}: due ${t.dueDate}`;
    },
  },
];

const cats = [
  { slug: "trabalho", name: "Trabalho", emoji: "💼", description: "emprego, reuniões, clientes" },
  { slug: "pessoal", name: "Pessoal", emoji: "🏠", description: "todo o resto", isDefault: true },
];

async function runCase(c: Case, round: number): Promise<string | null> {
  const ctx: Ctx = { store: memoryStore(TZ, 30, cats), db: await memoryDb(), tz: TZ, defaultReminder: 30 };
  const bytes = new Uint8Array(readFileSync(`scripts/fixtures/audio/${c.file}`));
  const media = { transcribe, downloadAudio: async () => ({ bytes, mime: "audio/ogg" }) };
  const reply = await handleMessage({ ...ctx, sourceMessageId: `aud-${round}-${c.file}` }, env, { text: "", mediaUrl: c.file, mediaMime: "audio/ogg" }, media);
  if (!reply.startsWith("🎤 _")) return `no transcript echo: ${reply.slice(0, 160)}`;
  const err = await c.check(ctx, reply);
  return err ? `${err}\n      ${reply.split("\n")[0]}` : null;
}

console.log(`transcribe=${model}  rounds=${ROUNDS}  clips=${CASES.length}\n`);
let ok = 0;
const fails: string[] = [];
for (let r = 0; r < ROUNDS; r++) {
  const results = await Promise.all(CASES.map((c) => runCase(c, r).catch((e) => `threw: ${e instanceof Error ? e.message : e}`)));
  results.forEach((err, i) => {
    process.stdout.write(err ? "✗" : "✓");
    if (err) fails.push(`[r${r}] ${CASES[i]!.file}: ${err}`);
    else ok++;
  });
}
console.log(`\n\n${fails.join("\n")}${fails.length ? "\n\n" : ""}correct: ${ok}/${ROUNDS * CASES.length}`);
process.exit(fails.length ? 1 : 0);
