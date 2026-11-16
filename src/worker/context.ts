import type { Db } from "./db/client";
import { icloudStore } from "./icloud/store";
import type { AppCtx } from "./llm/execute";

/** Production context: events in iCloud, control state in the DO's SQLite. */
export function makeCtx(env: Env, db: Db): AppCtx {
  const tz = env.TIMEZONE;
  const defaultReminder = Number(env.DEFAULT_REMINDER_MINUTES) || 30;
  return { store: icloudStore(env, db, tz, defaultReminder), db, tz, defaultReminder };
}
