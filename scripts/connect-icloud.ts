/**
 * Connect another user's own iCloud to the bot (two-way, like the owner's).
 * The app-specific password goes straight from this terminal to the worker
 * (HTTPS, DEBUG_TOKEN) and is stored encrypted; it never passes through
 * WhatsApp, the inbox or the model.
 *
 *   pnpm connect-icloud
 *
 * The person needs an app-specific password: account.apple.com → Sign-In and
 * Security → App-Specific Passwords. They don't need the invite code.
 * Re-run anytime (new password, other calendars).
 */
import { createInterface } from "node:readline/promises";

import { calendarHome, listCalendars } from "../src/worker/icloud/caldav";
import { canonPhone } from "../src/worker/zapi";
import { chooseCalendars } from "./lib/calendars";

const url = process.env.WORKER_URL;
const token = process.env.DEBUG_TOKEN;
if (!url || !token) throw new Error("WORKER_URL and DEBUG_TOKEN must be set in .dev.vars");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const die = (s: string): never => {
  console.error(`\x1b[31m✗\x1b[0m ${s}`);
  rl.close();
  process.exit(1);
};
const ask = async (q: string, def = "") => (await rl.question(`  ${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
const confirm = async (q: string, def = true) => {
  const a = (await rl.question(`  ${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return a ? a.startsWith("y") || a.startsWith("s") : def;
};

/** Typed but not echoed. */
async function secret(q: string): Promise<string> {
  process.stdout.write(`  ${q}: `);
  const out = process.stdout as unknown as { write: (s: string) => boolean };
  const write = out.write.bind(out);
  out.write = () => true;
  try {
    return (await rl.question("")).trim();
  } finally {
    out.write = write;
    process.stdout.write("\n");
  }
}

console.log("\n\x1b[1mConnect someone's iCloud\x1b[0m");
const phone = canonPhone(await ask("Their WhatsApp number (with country code)"));
if (phone.length < 10) die("That doesn't look like a phone number.");
const name = await ask("Their name", "");
const username = await ask("Apple ID (email)");
const password = await secret("App-specific password (xxxx-xxxx-xxxx-xxxx)");

const account = { ICLOUD_USERNAME: username, ICLOUD_APP_PASSWORD: password };
let cals;
try {
  cals = await listCalendars(account, await calendarHome(account));
} catch (err) {
  die(`iCloud login failed: ${err instanceof Error ? err.message : err}. Use an app-specific password, not the Apple ID password.`);
}
if (!cals!.length) die("No event calendars in this iCloud account.");
console.log(`\x1b[32m✓\x1b[0m iCloud login works (${cals!.length} calendars)\n`);

const categories = await chooseCalendars(cals!, { ask, confirm, die, log: (s) => console.log(s) });
const res = await fetch(`${url}/debug/icloud?user=${phone}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: name || undefined, username, password, categories }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) die(`worker refused (${res.status}): ${JSON.stringify(body)}`);
console.log(`\x1b[32m✓\x1b[0m connected: ${JSON.stringify(body)}`);
console.log(`  ${name || "They"} can now text the bot from ${phone}; a welcome message is on its way.\n`);
rl.close();
