import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/sql-js";
import initSqlJs from "sql.js";

import type { Db } from "../db/client";
import * as schema from "../db/schema";

/**
 * In-memory SQLite (sql.js/WASM) with the exact migrations the Durable Object
 * applies on startup. For tests, the eval and the iCloud smoke test.
 */
export async function memoryDb(): Promise<Db> {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  const dir = join(process.cwd(), "drizzle");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.run(stmt);
    }
  }
  return drizzle(sqlite, { schema }) as unknown as Db;
}
