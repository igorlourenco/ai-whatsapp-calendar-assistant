/**
 * Guided setup / redeploy for your own copy of the assistant.
 *
 *   pnpm configure              # interactive
 *   pnpm configure --dry-run    # validate credentials + show the plan, change nothing
 *   pnpm configure --yes        # accept defaults (re-runs: reuse calendars.json)
 *
 * Steps: credentials (.dev.vars) → validation (DeepSeek, Z-API, iCloud,
 * Cloudflare) → pick iCloud calendars as categories (calendars.json) →
 * deploy → upload secrets/settings → category mapping → Z-API webhook →
 * optional test message. Safe to re-run.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { DEFAULTS } from "../src/worker/config";
import { calendarHome, listCalendars, type RemoteCalendar } from "../src/worker/icloud/caldav";
import { chooseCalendars } from "./lib/calendars";

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");
const YES = ARGS.has("--yes");
const ENV_FILE = ".dev.vars";
const CAL_FILE = "calendars.json";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const c = { b: (s: string) => `\x1b[1m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` };
const ok = (s: string) => console.log(`${c.g("✓")} ${s}`);
const warn = (s: string) => console.log(`${c.y("!")} ${s}`);
const step = (s: string) => console.log(`\n${c.b(s)}`);
function die(s: string): never {
  console.error(`${c.r("✗")} ${s}`);
  rl.close();
  process.exit(1);
}

async function ask(q: string, def = ""): Promise<string> {
  if (YES) return def;
  const a = (await rl.question(`  ${q}${def ? c.d(` [${def}]`) : ""}: `)).trim();
  return a || def;
}
async function confirm(q: string, def = true): Promise<boolean> {
  if (YES) return def;
  const a = (await rl.question(`  ${q} ${c.d(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
  return a ? a.startsWith("y") || a.startsWith("s") : def;
}

/* --------------------------------- env ---------------------------------- */

type Env = Record<string, string>;
function readEnv(): Env {
  if (!existsSync(ENV_FILE)) return {};
  const env: Env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.trim();
  }
  return env;
}
function writeEnv(env: Env) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const seen = new Set<string>();
  const out = lines.map((l) => {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    if (!m || !(m[1]! in env)) return l;
    seen.add(m[1]!);
    return `${m[1]}=${env[m[1]!]}`;
  });
  for (const [k, v] of Object.entries(env)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, out.join("\n").replace(/\n*$/, "\n"));
}

const REQUIRED: [key: string, help: string][] = [
  ["DEEPSEEK_API_KEY", "DeepSeek API key (platform.deepseek.com → API keys)"],
  ["ZAPI_INSTANCE_ID", "Z-API instance ID (app.z-api.io → your instance)"],
  ["ZAPI_TOKEN", "Z-API instance token"],
  ["ZAPI_CLIENT_TOKEN", "Z-API account security token (Security → Client-Token)"],
  ["OWNER_PHONE", "Your WhatsApp number with country code, e.g. +55 11 91234 5678 (only this number talks to the bot)"],
  ["ICLOUD_USERNAME", "Apple ID email"],
  ["ICLOUD_APP_PASSWORD", "App-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords)"],
];
const SETTINGS: [key: keyof typeof DEFAULTS, help: string][] = [
  ["TIMEZONE", "Your IANA timezone"],
  ["MORNING_DIGEST_TIME", "Daily agenda time (HH:mm)"],
  ["EVENING_DIGEST_TIME", "Tomorrow preview time (HH:mm)"],
  ["DEFAULT_REMINDER_MINUTES", "Default reminder before timed events (minutes)"],
  ["DEEPSEEK_MODEL", "DeepSeek model"],
  ["VISION_MODEL", "Workers AI model that reads images"],
  ["TRANSCRIBE_MODEL", "Workers AI model that transcribes voice notes"],
  ["TASK_NAG_MINUTES", "Re-send pending tasks every N minutes on their due day (0 = off)"],
  ["TASK_NAG_UNTIL", "No task nags after this time (HH:mm)"],
];
// INVITE_CODE is optional (unset = only the owner); JSON.stringify drops it then.
const SECRET_KEYS = [...REQUIRED.map(([k]) => k), "ZAPI_WEBHOOK_TOKEN", "DEBUG_TOKEN", "CREDENTIALS_KEY", "INVITE_CODE", ...SETTINGS.map(([k]) => k)];

/* ------------------------------ validation ------------------------------ */

async function checkDeepSeek(env: Env) {
  const r = await fetch("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` } });
  if (!r.ok) die(`DeepSeek rejected the key (${r.status}).`);
  const models = ((await r.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  if (models.length && !models.includes(env.DEEPSEEK_MODEL!)) warn(`DeepSeek model "${env.DEEPSEEK_MODEL}" not in ${models.join(", ")}`);
  ok("DeepSeek key works");
}

function zapi(env: Env, path: string, init: RequestInit = {}) {
  return fetch(`https://api.z-api.io/instances/${env.ZAPI_INSTANCE_ID}/token/${env.ZAPI_TOKEN}/${path}`, {
    ...init,
    headers: { "Client-Token": env.ZAPI_CLIENT_TOKEN!, "Content-Type": "application/json", ...init.headers },
  });
}
async function checkZapi(env: Env) {
  const r = await zapi(env, "status");
  if (!r.ok) die(`Z-API rejected the credentials (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const s = (await r.json()) as { connected?: boolean; error?: string };
  if (s.connected) ok("Z-API instance is connected to WhatsApp");
  else warn("Z-API instance is NOT connected: scan the QR code in the Z-API panel before using the bot");
}

async function checkICloud(env: Env): Promise<RemoteCalendar[]> {
  try {
    const cals = await listCalendars(env as never, await calendarHome(env as never));
    if (!cals.length) die("No event calendars found in this iCloud account.");
    ok(`iCloud login works (${cals.length} calendars)`);
    return cals;
  } catch (err) {
    die(`iCloud login failed: ${err instanceof Error ? err.message : err}. Use an app-specific password, not your Apple ID password.`);
  }
}

function wrangler(args: string[], input?: string) {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", input, stdio: input === undefined ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/* ------------------------------- calendars ------------------------------ */

/* --------------------------------- main --------------------------------- */

console.log(c.b("\nWhatsApp Calendar Assistant setup") + (DRY ? c.y("  (dry run: nothing will be changed)") : ""));

step("1. Credentials");
const env = readEnv();
for (const [k, help] of REQUIRED) {
  if (env[k]) continue;
  if (YES) die(`${k} missing in ${ENV_FILE}`);
  console.log(c.d(`  ${help}`));
  env[k] = await ask(k);
  if (!env[k]) die(`${k} is required`);
}
for (const [k, help] of SETTINGS) {
  if (env[k]) continue;
  const def = k === "TIMEZONE" ? Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULTS.TIMEZONE : DEFAULTS[k];
  env[k] = await ask(help, def);
}
env.ZAPI_WEBHOOK_TOKEN ||= randomBytes(24).toString("hex");
env.DEBUG_TOKEN ||= randomBytes(32).toString("hex");
env.CREDENTIALS_KEY ||= randomBytes(32).toString("base64");
try {
  new Intl.DateTimeFormat("en-US", { timeZone: env.TIMEZONE });
} catch {
  die(`Invalid TIMEZONE "${env.TIMEZONE}" (examples: America/Sao_Paulo, Europe/Lisbon)`);
}
if (!DRY) writeEnv(env);
ok(`credentials ${DRY ? "complete" : `saved to ${ENV_FILE} (git-ignored)`}`);

step("2. Validation");
await checkDeepSeek(env);
await checkZapi(env);
const cals = await checkICloud(env);
const who = wrangler(["whoami"]);
if (!who.ok || /not authenticated/i.test(who.out)) die("Cloudflare: run `npx wrangler login` first.");
ok("Cloudflare login works");

step("3. Calendars → categories");
const choices = await chooseCalendars(cals, { ask, confirm, die, savedFile: CAL_FILE, log: (x) => console.log(x) });
if (!DRY) writeFileSync(CAL_FILE, `${JSON.stringify(choices, null, 2)}\n`);
ok(`${choices.length} categories: ${choices.map((x) => `${x.emoji} ${x.name}${x.isDefault ? " (default)" : ""}`).join(", ")}`);

if (DRY) {
  step("Plan");
  console.log(`  deploy worker → upload ${SECRET_KEYS.length} secrets/settings → set category mapping → point Z-API "on receive" webhook to the worker`);
  rl.close();
  process.exit(0);
}

step("4. Deploy");
const dep = wrangler(["deploy"]);
if (!dep.ok) die(`deploy failed:\n${dep.out.slice(-1500)}`);
const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(dep.out)?.[0] ?? env.WORKER_URL;
if (!url) die("Couldn't find the worker URL in the deploy output; set WORKER_URL in .dev.vars and re-run.");
env.WORKER_URL = url;
writeEnv(env);
ok(`deployed: ${url}`);

step("5. Secrets & settings");
const sec = wrangler(["secret", "bulk"], JSON.stringify(Object.fromEntries(SECRET_KEYS.map((k) => [k, env[k]!]))));
if (!sec.ok) die(`uploading secrets failed:\n${sec.out.slice(-800)}`);
ok(`${SECRET_KEYS.length} secrets uploaded`);

step("6. Category mapping");
const auth = { Authorization: `Bearer ${env.DEBUG_TOKEN}`, "Content-Type": "application/json" };
let mapped: Response | null = null;
for (let i = 0; i < 10; i++) {
  // Secrets roll out as a new version; give it a moment to see the new DEBUG_TOKEN.
  mapped = await fetch(`${url}/debug/categories`, { method: "PUT", headers: auth, body: JSON.stringify(choices) });
  if (mapped.status !== 401) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (!mapped?.ok) die(`setting categories failed (${mapped?.status}): ${await mapped?.text()}`);
ok(`categories saved (${JSON.stringify(await mapped.json())})`);

step("7. WhatsApp webhook");
const hook = `${url}/webhooks/zapi?token=${env.ZAPI_WEBHOOK_TOKEN}`;
const me = (await (await zapi(env, "me")).json().catch(() => ({}))) as { receivedCallbackUrl?: string };
const current = me.receivedCallbackUrl ?? "";
if (current === hook) ok("Z-API webhook already points to this worker");
else {
  if (current && !current.startsWith(url)) {
    warn(`The instance's "on receive" webhook currently points to: ${current.replace(/token=[^&]+/, "token=***")}`);
    if (!(await confirm("Replace it with this worker? (the other app stops receiving messages)", false))) {
      warn("Webhook left unchanged: the bot won't receive messages until you point it here.");
    } else await setHook();
  } else await setHook();
}
async function setHook() {
  const r = await zapi(env, "update-webhook-received", { method: "PUT", body: JSON.stringify({ value: hook }) });
  if (!r.ok) die(`setting the webhook failed (${r.status}): ${await r.text()}`);
  ok("Z-API webhook → worker");
}

step("8. Test");
if (await confirm("Send a test WhatsApp message to OWNER_PHONE?", !YES)) {
  const r = await zapi(env, "send-text", {
    method: "POST",
    body: JSON.stringify({
      phone: env.OWNER_PHONE!.replace(/\D/g, ""),
      message: "✅ Assistente de agenda conectado!\n\nExperimente:\n• _dentista sexta 15h_\n• _o que tenho amanhã?_",
    }),
  });
  if (r.ok) ok("test message sent: reply to it on WhatsApp to try the bot");
  else warn(`test message failed (${r.status})`);
}

console.log(`\n${c.g(c.b("Done."))} Inspect anytime with ${c.b("pnpm db state")}. Re-run ${c.b("pnpm configure")} after changing .dev.vars or calendars.\n`);
rl.close();
