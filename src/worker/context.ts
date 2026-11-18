import { sqliteStore } from "./calendar/sqlite-store";
import type { Db } from "./db/client";
import type { Profile } from "./db/schema";
import { icloudStore } from "./icloud/store";
import type { AppCtx } from "./llm/execute";
import { isGuest, userSettings } from "./users";

/**
 * Production context. Owner: events in iCloud. Everyone else: events in their
 * own object's SQLite. Control state is always in the object's SQLite.
 */
export function makeCtx(env: Env, db: Db, p: Profile | null): AppCtx {
  const { tz, defaultReminder, taskNagMinutes, morningAt, eveningAt } = userSettings(env, p);
  const store = isGuest(p) ? sqliteStore(db, tz, defaultReminder) : icloudStore(env, db, tz, defaultReminder);
  return { store, db, tz, defaultReminder, taskNagMinutes, user: { guest: isGuest(p), feedUrl: p?.feedUrl ?? null, morningAt, eveningAt } };
}
