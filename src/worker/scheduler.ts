import { DurableObject } from "cloudflare:workers";
import { asc, inArray } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/migrations.js";
import { makeCtx } from "./context";
import type { Db } from "./db/client";
import * as schema from "./db/schema";
import { inboundMessages } from "./db/schema";
import { exportAll, importAll, readOnlyQuery, snapshot, type ExportData } from "./debug";
import { OPEN_STATUSES, processInbox } from "./inbox";
import { handleMessage, type AppCtx } from "./llm/execute";
import { nextWakeUp, runDue, type CronConfig } from "./notifications";
import { sendText } from "./zapi";

/** Never sleep longer than this, so a missed reschedule self-heals. */
const MAX_SLEEP_MS = 12 * 60 * 60_000;
const MIN_SLEEP_MS = 1_000;
/** Retry delay when reminders/digests failed to send. */
const DUE_RETRY_MS = 60_000;

export type Inbound = { messageId: string; phone: string; text: string };

/**
 * Single-instance Durable Object that owns all state and everything
 * time-based. Its embedded SQLite (migrated on startup) holds the inbox,
 * conversation state and send logs; events live in iCloud.
 *
 * 1. Inbox: enqueue() stores each WhatsApp message durably and wakes the
 *    alarm. Messages are processed strictly in arrival order with retries +
 *    backoff; after MAX_ATTEMPTS the user gets an explicit failure notice.
 * 2. Notifications: reminders + digests via one alarm set to the next due time.
 *
 * Being one instance serializes all writes (no races between messages).
 *
 * ⚠️ The data lives inside this class. Never rename or delete `Scheduler` in a
 * wrangler migration without exporting first (GET /debug/export).
 */
export class Scheduler extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof schema>;
  /** Set by enqueue(); survives an in-flight alarm overwriting the alarm time. */
  private kicked = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.db = drizzle(state.storage, { schema });
    void state.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  private appCtx(): AppCtx {
    return makeCtx(this.env, this.db as unknown as Db);
  }

  private cfg(): CronConfig {
    return { morningAt: this.env.MORNING_DIGEST_TIME, eveningAt: this.env.EVENING_DIGEST_TIME };
  }

  /** Store a WhatsApp message (idempotent on messageId) and process ASAP. */
  async enqueue(m: Inbound): Promise<void> {
    await this.db
      .insert(inboundMessages)
      .values({ messageId: m.messageId, phone: m.phone, text: m.text, status: "pending" })
      .onConflictDoNothing();
    this.kicked = true;
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Recompute the next wake-up and arm the alarm. Returns it (ISO) for logging. */
  async reschedule(opts: { retryAt?: number } = {}): Promise<string> {
    const now = Date.now();
    let at = (await nextWakeUp(this.appCtx(), this.cfg(), new Date(now))).getTime();
    if (opts.retryAt) at = Math.min(at, opts.retryAt);

    const [open] = await this.db
      .select({ next: inboundMessages.nextAttemptAt })
      .from(inboundMessages)
      .where(inArray(inboundMessages.status, [...OPEN_STATUSES]))
      .orderBy(asc(inboundMessages.receivedAt))
      .limit(1);
    if (open) at = Math.min(at, open.next.getTime());
    if (this.kicked) at = now;

    at = Math.min(Math.max(at, now + MIN_SLEEP_MS), now + MAX_SLEEP_MS);
    await this.ctx.storage.setAlarm(at);
    return new Date(at).toISOString();
  }

  /** Watchdog: arm only if no alarm is pending. */
  async ensureArmed(): Promise<string> {
    const pending = await this.ctx.storage.getAlarm();
    return pending ? new Date(pending).toISOString() : this.reschedule();
  }

  async alarm(): Promise<void> {
    this.kicked = false;
    const ctx = this.appCtx();
    let retryAt: number | undefined;

    try {
      await processInbox(ctx, {
        handle: (c, text) => handleMessage(c, this.env, text),
        send: (phone, msg) => sendText(this.env, phone, msg),
      });
    } catch (err) {
      console.error("[inbox] run failed", err);
      retryAt = Date.now() + DUE_RETRY_MS;
    }
    try {
      // Claimed in reminder_log/digest_log first, released on send failure.
      await runDue(ctx, this.cfg(), (msg) => sendText(this.env, this.env.OWNER_PHONE, msg));
    } catch (err) {
      console.error("[notifications] failed", err);
      retryAt = Date.now() + DUE_RETRY_MS;
    }
    await this.reschedule({ retryAt });
  }

  /* ----------------------- debug / ops (token-guarded) ---------------------- */

  async debugSnapshot() {
    const alarm = await this.ctx.storage.getAlarm();
    return { ...(await snapshot(this.db as unknown as Db)), nextAlarm: alarm ? new Date(alarm).toISOString() : null };
  }

  /** Ad-hoc SQL, read-only: runs in a transaction that is always rolled back. */
  debugQuery(sql: string) {
    return readOnlyQuery(this.ctx.storage, sql);
  }

  async debugExport(): Promise<ExportData> {
    return exportAll(this.db as unknown as Db);
  }

  /** Insert-only import (never overwrites or deletes). Used for backups and the Neon move. */
  async debugImport(data: ExportData) {
    const result = await importAll(this.db as unknown as Db, data);
    // Best-effort: the import itself is done; a failing iCloud read must not
    // turn it into an error (the next alarm/watchdog re-arms anyway).
    const nextAlarm = await this.reschedule().catch((err) => `not rescheduled: ${err}`);
    return { ...result, nextAlarm };
  }

  /**
   * Point-in-time recovery (up to 30 days back): the object restarts with its
   * storage as it was at `at`. Everything after that moment is discarded.
   */
  async debugRestore(at: string) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) throw new Error("invalid time");
    const bookmark = await this.ctx.storage.getBookmarkForTime(when);
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    // Restart after replying, so the caller sees success or a real error.
    setTimeout(() => this.ctx.abort("restoring point-in-time bookmark"), 50);
    return { restoredTo: when.toISOString(), bookmark };
  }
}

export function scheduler(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("main"));
}
