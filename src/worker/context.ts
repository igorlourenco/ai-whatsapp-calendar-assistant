import { getDb } from "./db/client";
import { icloudStore } from "./icloud/store";
import type { AppCtx } from "./llm/execute";

/** Production context: events in iCloud, everything else in Neon. */
export function makeCtx(env: Env): AppCtx {
  const db = getDb(env);
  const tz = env.TIMEZONE;
  const defaultReminder = Number(env.DEFAULT_REMINDER_MINUTES) || 30;
  return { store: icloudStore(env, db, tz, defaultReminder), db, tz, defaultReminder };
}
