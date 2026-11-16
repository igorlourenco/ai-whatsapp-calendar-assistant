/**
 * Inspect the Durable Object's SQLite from your terminal.
 *   pnpm db "select * from inbound_messages order by received_at desc limit 5"
 *   pnpm db state          # inbox, conversation state, recent sends, next alarm
 *   pnpm db export > backup.json
 *   pnpm db import backup.json   # insert-only
 *   pnpm db restore 2026-11-16T12:00:00Z --yes   # point-in-time (≤30 days); discards later changes
 */
import { readFileSync } from "node:fs";

const [cmd, arg] = process.argv.slice(2);
const url = process.env.WORKER_URL;
const token = process.env.DEBUG_TOKEN;
if (!url || !token) throw new Error("WORKER_URL and DEBUG_TOKEN must be set in .dev.vars");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let res: Response;
if (!cmd || cmd === "state") res = await fetch(`${url}/debug/state`, { headers });
else if (cmd === "export") res = await fetch(`${url}/debug/export`, { headers });
else if (cmd === "restore") {
  if (!arg || process.argv[4] !== "--yes") throw new Error("usage: pnpm db restore <ISO time> --yes  (discards every change after that time)");
  res = await fetch(`${url}/debug/restore`, { method: "POST", headers, body: JSON.stringify({ at: arg, confirm: "restore" }) });
} else if (cmd === "import") res = await fetch(`${url}/debug/import`, { method: "POST", headers, body: readFileSync(arg!, "utf8") });
else res = await fetch(`${url}/debug/query`, { method: "POST", headers, body: JSON.stringify({ sql: cmd }) });

const body = await res.json();
if (!res.ok) {
  console.error(body);
  process.exit(1);
}
const rows = (body as { rows?: Record<string, unknown>[] }).rows;
if (rows && process.stdout.isTTY) console.table(rows);
else console.log(JSON.stringify(body, null, 2));
