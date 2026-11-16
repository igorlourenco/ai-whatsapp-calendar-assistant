import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

export function getDb(env: { DATABASE_URL: string }) {
  return drizzle(neon(env.DATABASE_URL), { schema });
}

export type Db = ReturnType<typeof getDb>;
export { schema };
