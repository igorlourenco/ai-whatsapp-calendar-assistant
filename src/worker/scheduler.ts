import { DurableObject } from "cloudflare:workers";
import { asc, inArray } from "drizzle-orm";

import { makeCtx } from "./context";
import { inboundMessages } from "./db/schema";
import { OPEN_STATUSES, processInbox } from "./inbox";
import { handleMessage, type AppCtx } from "./llm/execute";
import { nextWakeUp, runDue, type CronConfig } from "./notifications";
import { sendText } from "./zapi";

/** Never sleep longer than this, so a missed reschedule self-heals. */
const MAX_SLEEP_MS = 12 * 60 * 60_000;
const MIN_SLEEP_MS = 1_000;
/** Retry delay when reminders/digests failed to send. */
const DUE_RETRY_MS = 60_000;

/**
 * Single-instance Durable Object that owns everything time-based:
 *
 * 1. Inbox: the webhook stores each WhatsApp message in `inbound_messages`
 *    and calls kick(). Messages are processed strictly in arrival order with
 *    retries + backoff. No 30s waitUntil cap, no silent loss: after
 *    MAX_ATTEMPTS the user gets an explicit failure notice.
 * 2. Notifications: reminders + digests, via one alarm set to the next due
 *    time, so Neon is only touched when there's work.
 *
 * Being one instance also serializes all writes (no races between messages).
 */
export class Scheduler extends DurableObject<Env> {
  /** Set by kick(); survives an in-flight alarm overwriting the alarm time. */
  private kicked = false;

  private toolCtx(): AppCtx {
    return makeCtx(this.env);
  }

  private cfg(): CronConfig {
    return { morningAt: this.env.MORNING_DIGEST_TIME, eveningAt: this.env.EVENING_DIGEST_TIME };
  }

  /** New inbound message stored: process ASAP. */
  async kick(): Promise<void> {
    this.kicked = true;
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Recompute the next wake-up and arm the alarm. Returns it (ISO) for logging. */
  async reschedule(opts: { retryAt?: number } = {}): Promise<string> {
    const now = Date.now();
    const ctx = this.toolCtx();
    let at = (await nextWakeUp(ctx, this.cfg(), new Date(now))).getTime();
    if (opts.retryAt) at = Math.min(at, opts.retryAt);

    const [open] = await ctx.db
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

  /** Watchdog: arm only if no alarm is pending (no DB hit otherwise). */
  async ensureArmed(): Promise<string> {
    const pending = await this.ctx.storage.getAlarm();
    return pending ? new Date(pending).toISOString() : this.reschedule();
  }

  async alarm(): Promise<void> {
    this.kicked = false;
    const ctx = this.toolCtx();
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
}

export function scheduler(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("main"));
}
