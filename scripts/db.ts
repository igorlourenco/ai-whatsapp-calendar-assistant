/**
 * Inspect the Durable Object's SQLite from your terminal.
 *   pnpm db "select * from inbound_messages order by received_at desc limit 5"
 *   pnpm db state          # inbox, conversation state, recent sends, next alarm
 *   pnpm db export > backup.json
 *   pnpm db import backup.json   # insert-only
 *   pnpm db restore 2026-11-16T12:00:00Z --yes   # point-in-time (≤30 days); discards later changes
 *   pnpm db users                # who has access besides you
 *   pnpm db add-user 5563912345678 "Ana"   # give someone access (no public signup)
 *   DB_USER=5563912345678 pnpm db state   # any command on another user's object
 */
import { readFileSync } from "node:fs";

const [cmd, arg] = process.argv.slice(2);
const url = process.env.WORKER_URL;
const token = process.env.DEBUG_TOKEN;
if (!url || !token) throw new Error("WORKER_URL and DEBUG_TOKEN must be set in .dev.vars");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
// Another user's object: DB_USER=5563912345678 pnpm db state
const userQs = process.env.DB_USER ? `?user=${encodeURIComponent(process.env.DB_USER)}` : "";

let res: Response;
if (!cmd || cmd === "state") res = await fetch(`${url}/debug/state${userQs}`, { headers });
else if (cmd === "users") res = await fetch(`${url}/debug/users`, { headers });
else if (cmd === "add-user") {
  if (!arg) throw new Error('usage: pnpm db add-user <phone> ["Name"]');
  res = await fetch(`${url}/debug/users`, { method: "POST", headers, body: JSON.stringify({ phone: arg, name: process.argv[4] }) });
}
else if (cmd === "export") res = await fetch(`${url}/debug/export${userQs}`, { headers });
else if (cmd === "restore") {
  if (!arg || process.argv[4] !== "--yes") throw new Error("usage: pnpm db restore <ISO time> --yes  (discards every change after that time)");
  res = await fetch(`${url}/debug/restore${userQs}`, { method: "POST", headers, body: JSON.stringify({ at: arg, confirm: "restore" }) });
} else if (cmd === "import") res = await fetch(`${url}/debug/import${userQs}`, { method: "POST", headers, body: readFileSync(arg!, "utf8") });
else res = await fetch(`${url}/debug/query${userQs}`, { method: "POST", headers, body: JSON.stringify({ sql: cmd }) });

const body = await res.json();
if (!res.ok) {
  console.error(body);
  process.exit(1);
}
const rows = (body as { rows?: Record<string, unknown>[] }).rows;
if (rows && process.stdout.isTTY) console.table(rows);
else console.log(JSON.stringify(body, null, 2));
