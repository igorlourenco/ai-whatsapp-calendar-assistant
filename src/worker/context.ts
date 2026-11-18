import { sqliteStore } from "./calendar/sqlite-store";
import type { Db } from "./db/client";
import type { Profile } from "./db/schema";
import type { ICloudEnv } from "./icloud/caldav";
import { icloudStore } from "./icloud/store";
import type { AppCtx } from "./llm/execute";
import { open } from "./secrets";
import { isGuest, userSettings } from "./users";

/** Whose iCloud: the user's own (encrypted in their profile), else the deployment's (owner). */
export async function icloudAccount(env: Env, p: Profile | null): Promise<ICloudEnv> {
  if (!p?.icloudCredentials) return env;
  const { username, password } = JSON.parse(await open(env.CREDENTIALS_KEY, p.icloudCredentials)) as { username: string; password: string };
  return { ICLOUD_USERNAME: username, ICLOUD_APP_PASSWORD: password };
}

/**
 * Production context. Events in iCloud (the owner's, or the user's own), or
 * in the object's SQLite for users without iCloud. Control state is always
 * in the object's SQLite.
 */
export async function makeCtx(env: Env, db: Db, p: Profile | null): Promise<AppCtx> {
  const { tz, defaultReminder, taskNagMinutes, morningAt, eveningAt } = userSettings(env, p);
  const store = isGuest(p) ? sqliteStore(db, tz, defaultReminder) : icloudStore(await icloudAccount(env, p), db, tz, defaultReminder);
  return { store, db, tz, defaultReminder, taskNagMinutes, user: { guest: isGuest(p), feedUrl: p?.feedUrl ?? null, morningAt, eveningAt } };
}
