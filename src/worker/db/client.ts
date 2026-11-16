import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import * as schema from "./schema";

/**
 * Any Drizzle SQLite database with our schema: the Durable Object's embedded
 * SQLite in production (sync driver), sql.js in tests and the eval.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = BaseSQLiteDatabase<"sync" | "async", any, typeof schema>;

export { schema };
