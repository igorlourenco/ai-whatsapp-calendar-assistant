/**
 * End-to-end image eval with the REAL models: Workers AI vision (REST, your
 * wrangler login) → DeepSeek extraction → preview → "sim" → saved events.
 * In-memory store and SQLite: never touches iCloud or WhatsApp.
 *
 *   pnpm eval:images        # 3 rounds
 *   pnpm eval:images 5
 *
 * Fixtures: scripts/fixtures/images (synthetic, Portuguese). Dates are
 * expected relative to 2026-11-16 (the images say dd/mm without year).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { memoryStore } from "../src/worker/calendar/memory-store";
import { settings } from "../src/worker/config";
import { handleMessage, type AppCtx } from "../src/worker/llm/execute";
import { VISION_PROMPT, normalizeTranscript, type Vision } from "../src/worker/llm/vision";
import { memoryDb } from "../src/worker/testing/sqlite";
import { localDate, localDateTime } from "../src/worker/time";

const TZ = "America/Araguaina";
const ROUNDS = Number(process.argv[2] ?? 3);
const env = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY!, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL };
const model = settings(process.env).visionModel;

const token = execSync("npx wrangler auth token 2>/dev/null", { encoding: "utf8" }).match(/\S{30,}/)?.[0];
const account = execSync("npx wrangler whoami 2>/dev/null", { encoding: "utf8" }).match(/[0-9a-f]{32}/)?.[0];
if (!token || !account) throw new Error("run `npx wrangler login` first");

const vision: Vision = async (bytes, mime) => {
  const body = {
    messages: [{ role: "user", content: [{ type: "text", text: VISION_PROMPT }, { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } }] }],
    max_tokens: 1500,
    temperature: 0,
  };
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { success: boolean; result?: { response?: string }; errors?: unknown };
  if (!j.success) throw new Error(`Workers AI: ${JSON.stringify(j.errors)}`);
  return normalizeTranscript(j.result?.response ?? "");
};

type Exp = { title: RegExp; date: string; time?: string; end?: string; allDay?: boolean; lastDay?: string; location?: RegExp };
const CASES: { file: string; expect: Exp[] }[] = [
  {
    file: "provas.png",
    expect: [
      { title: /penal/i, date: "2026-11-24", time: "19:00" },
      { title: /processo civil/i, date: "2026-11-26", time: "19:00" },
      { title: /constitucional/i, date: "2026-12-01", time: "08:00" },
      { title: /tgp/i, date: "2026-12-03", time: "14:00", end: "16:00" },
    ],
  },
  { file: "workshop.png", expect: [{ title: /workshop|digital/i, date: "2026-11-28", time: "19:00", end: "21:00", location: /audit/i }] },
  { file: "chat.png", expect: [{ title: /reuni/i, date: "2026-11-19", time: "10:30" }] },
  { file: "semana-juridica.png", expect: [{ title: /semana jur/i, date: "2026-12-07", allDay: true, lastDay: "2026-12-11" }] },
  {
    file: "bilhete-foto.jpg",
    expect: [
      { title: /dentista/i, date: "2026-11-23", time: "15:00" },
      { title: /passaporte/i, date: "2026-11-25" },
      { title: /anivers|ju/i, date: "2026-11-28" },
    ],
  },
];

const cats = [
  { slug: "faculdade", name: "Faculdade", emoji: "🎓", description: "aulas, provas, trabalhos e compromissos acadêmicos" },
  { slug: "trabalho", name: "Trabalho", emoji: "💼", description: "emprego, reuniões" },
  { slug: "pessoal", name: "Pessoal", emoji: "🏠", description: "todo o resto", isDefault: true },
];

async function runCase(c: (typeof CASES)[number], round: number): Promise<string | null> {
  const store = memoryStore(TZ, 30, cats);
  const ctx: AppCtx = { store, db: await memoryDb(), tz: TZ, defaultReminder: 30 };
  const bytes = new Uint8Array(readFileSync(`scripts/fixtures/images/${c.file}`));
  const mime = c.file.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const media = { vision, download: async () => ({ bytes, mime }) };

  const preview = await handleMessage({ ...ctx, sourceMessageId: `img-${round}-${c.file}` }, env, { text: "", mediaUrl: c.file, mediaMime: mime }, media);
  if (store.all().length) return "saved before confirmation!";
  if (!preview.startsWith("📷")) return `no preview: ${preview.slice(0, 160)}`;
  const reply = await handleMessage(ctx, env, "sim", media);
  const saved = store.all();
  if (!/✅/.test(reply)) return `no confirmation after "sim": ${reply.slice(0, 160)}`;

  const errs: string[] = [];
  if (saved.length !== c.expect.length) errs.push(`saved ${saved.length}, expected ${c.expect.length}: ${saved.map((s) => s.title).join(" | ")}`);
  for (const e of c.expect) {
    const ev = saved.find((s) => e.title.test(s.title) && localDate(s.startAt, TZ) === e.date);
    if (!ev) {
      errs.push(`missing ${e.title} on ${e.date} (got: ${saved.map((s) => `${s.title}@${localDateTime(s.startAt, TZ)}`).join(", ")})`);
      continue;
    }
    if (e.time && localDateTime(ev.startAt, TZ).slice(11) !== e.time) errs.push(`${ev.title}: start ${localDateTime(ev.startAt, TZ)} ≠ ${e.time}`);
    if (e.end && localDateTime(ev.endAt, TZ).slice(11) !== e.end) errs.push(`${ev.title}: end ${localDateTime(ev.endAt, TZ)} ≠ ${e.end}`);
    if (e.allDay !== undefined && ev.allDay !== e.allDay) errs.push(`${ev.title}: allDay ${ev.allDay}`);
    if (e.lastDay && localDate(new Date(ev.endAt.getTime() - 1), TZ) !== e.lastDay) errs.push(`${ev.title}: last day wrong`);
    if (e.location && !e.location.test(ev.location ?? "")) errs.push(`${ev.title}: location "${ev.location}"`);
  }
  return errs.length ? errs.join("; ") : null;
}

console.log(`vision=${model}  rounds=${ROUNDS}  images=${CASES.length}\n`);
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
