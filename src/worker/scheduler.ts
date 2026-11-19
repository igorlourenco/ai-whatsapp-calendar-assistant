import { DurableObject } from "cloudflare:workers";
import { asc, inArray } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/migrations.js";
import { sqliteStore } from "./calendar/sqlite-store";
import { makeCtx } from "./context";
import type { Db } from "./db/client";
import * as schema from "./db/schema";
import { inboundMessages, type Profile } from "./db/schema";
import { buildFeed } from "./icloud/ics";
import { categoryRows, exportAll, importAll, readOnlyQuery, snapshot, type CategoryConfig, type ExportData } from "./debug";
import { OPEN_STATUSES, processInbox } from "./inbox";
import { handleMessage, type AppCtx } from "./llm/execute";
import { fetchAudio, workersAiWhisper } from "./llm/transcribe";
import { fetchImage, workersAiVision } from "./llm/vision";
import { nextWakeUp, runDue, type CronConfig } from "./notifications";
import { addUser, findUser, findUserByToken, listUsers, loadProfile, removeUser, setupGuest, userSettings } from "./users";
import { calendarHome } from "./icloud/caldav";
import { seal } from "./secrets";
import { cancelCode, requestCode, verifyCode } from "./signup";
import { localDate, localDateTime } from "./time";
import { canonPhone, digits, samePhone, sendText } from "./zapi";

/** Never sleep longer than this, so a missed reschedule self-heals. */
const MAX_SLEEP_MS = 12 * 60 * 60_000;
const MIN_SLEEP_MS = 1_000;
/** Retry delay when reminders/digests failed to send. */
const DUE_RETRY_MS = 60_000;

export type Inbound = { messageId: string; phone: string; text: string; mediaUrl?: string | null; mediaMime?: string | null };

/**
 * One Durable Object per user (the owner's is "main") that owns all of that
 * user's state and everything time-based. Its embedded SQLite (migrated on
 * startup) holds the inbox, conversation state, tasks and send logs; events
 * live in iCloud (owner) or in this SQLite too (guests, see users.ts). A
 * separate "registry" object of the same class keeps the users table.
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

  private get sqlDb(): Db {
    return this.db as unknown as Db;
  }

  /** Read per call: a settings change by message applies to the very next alarm. */
  private async profile(): Promise<Profile | null> {
    return loadProfile(this.sqlDb);
  }

  private appCtx(p: Profile | null): Promise<AppCtx> {
    return makeCtx(this.env, this.sqlDb, p);
  }

  private cfg(p: Profile | null): CronConfig {
    const { morningAt, eveningAt, taskNagMinutes, taskNagUntil } = userSettings(this.env, p);
    return { morningAt, eveningAt, taskNagMinutes, taskNagUntil };
  }

  /** Who gets reminders/digests: the user's own phone (only the owner's object has none). */
  private notifyPhone(p: Profile | null): string {
    return p?.phone ?? this.env.OWNER_PHONE;
  }

  /** Store a WhatsApp message (idempotent on messageId) and process ASAP. */
  async enqueue(m: Inbound): Promise<void> {
    // Reminders/digests go to the number exactly as WhatsApp reports it.
    const p = await this.profile();
    if (p?.phone && p.phone !== digits(m.phone)) {
      await this.db.update(schema.profile).set({ phone: digits(m.phone) });
    }
    await this.db
      .insert(inboundMessages)
      .values({
        messageId: m.messageId,
        phone: m.phone,
        text: m.text,
        mediaUrl: m.mediaUrl ?? null,
        mediaMime: m.mediaMime ?? null,
        status: "pending",
      })
      .onConflictDoNothing();
    this.kicked = true;
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Recompute the next wake-up and arm the alarm. Returns it (ISO) for logging. */
  async reschedule(opts: { retryAt?: number } = {}): Promise<string> {
    const now = Date.now();
    const p = await this.profile();
    let at = (await nextWakeUp(await this.appCtx(p), this.cfg(p), new Date(now))).getTime();
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
    const p = await this.profile();
    const ctx = await this.appCtx(p);
    let retryAt: number | undefined;

    try {
      await processInbox(ctx, {
        handle: (c, msg) => {
          const models = userSettings(this.env, p);
          return handleMessage(c, this.env, msg, {
            vision: workersAiVision(this.env.AI, models.visionModel),
            download: fetchImage,
            transcribe: workersAiWhisper(this.env.AI, models.transcribeModel),
            downloadAudio: fetchAudio,
          });
        },
        send: (phone, msg) => sendText(this.env, phone, msg),
      });
    } catch (err) {
      console.error("[inbox] run failed", err);
      retryAt = Date.now() + DUE_RETRY_MS;
    }
    try {
      // Claimed in reminder_log/digest_log first, released on send failure.
      await runDue(ctx, this.cfg(p), (msg) => sendText(this.env, this.notifyPhone(p), msg));
    } catch (err) {
      console.error("[notifications] failed", err);
      retryAt = Date.now() + DUE_RETRY_MS;
    }
    await this.reschedule({ retryAt });
  }

  /* ------------------------------- guests -------------------------------- */

  /**
   * A new user's object: profile + starter categories, and the welcome
   * message queued in the inbox (sent with the usual retries). Idempotent:
   * sending the code again just re-sends the welcome.
   */
  async join(m: { messageId: string; phone: string; name: string | null; feedUrl: string; welcome: string; tz?: string | null }): Promise<void> {
    await setupGuest(this.sqlDb, m.phone, m.name, m.feedUrl, m.tz);
    await this.db
      .insert(inboundMessages)
      .values({ messageId: m.messageId, phone: m.phone, text: "", status: "answered", reply: m.welcome })
      .onConflictDoNothing();
    this.kicked = true;
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Has this object been set up (and how)? For the signup page. */
  async storageKind(): Promise<"icloud" | "local" | null> {
    return (await this.profile())?.storage ?? null;
  }

  /** This user's events as an ICS feed (guests only; null for the owner). */
  async feed(): Promise<string | null> {
    const p = await this.profile();
    if (p?.storage !== "local") return null;
    const { tz, defaultReminder } = userSettings(this.env, p);
    const store = sqliteStore(this.sqlDb, tz, defaultReminder);
    const cats = await store.listCategories();
    const rows = await store.allRows();
    const list = rows.map((r) => {
      const allDay = r.allDay;
      const lastExclusive = allDay ? new Date(r.endAt) : null;
      return {
        uid: `${r.id}@ai-assistant-wpp`,
        title: r.title,
        start: r.startAt,
        end: r.endAt,
        allDay,
        startDate: allDay ? localDate(r.startAt, tz) : undefined,
        endDateExclusive: lastExclusive ? localDate(lastExclusive, tz) : undefined,
        location: r.location,
        notes: r.notes,
        recurrence: r.recurrence,
        reminderMinutes: r.reminderMinutes,
        exdates: r.exdates,
        category: cats.find((c) => c.id === r.categoryId)?.name ?? null,
      };
    });
    return buildFeed(p.name ? `Agenda · ${p.name}` : "Agenda", list, tz);
  }

  /**
   * Point this user's object at their own iCloud (two-way, like the owner).
   * Validates the login, stores it encrypted, replaces the categories with
   * the chosen calendars and moves any events the user had in the bot's
   * SQLite into iCloud. Safe to re-run (e.g. new app password).
   */
  async connectICloud(m: { phone: string; name: string | null; username: string; password: string; categories: CategoryConfig[] }) {
    const account = { ICLOUD_USERNAME: m.username, ICLOUD_APP_PASSWORD: m.password };
    await calendarHome(account); // throws on a bad login: nothing changes
    const { rows } = categoryRows(m.categories);
    const sealed = await seal(this.env.CREDENTIALS_KEY, JSON.stringify({ username: m.username, password: m.password }));

    const before = await this.profile();
    const local = before?.storage === "local" ? await sqliteStore(this.sqlDb, userSettings(this.env, before).tz, 30).allRows() : [];
    const oldCats = await this.db.select().from(schema.categories);
    // Send address as given (not canonPhone: WhatsApp may need the BR 9th digit).
    const values = { phone: digits(m.phone), name: m.name ?? before?.name ?? null, storage: "icloud" as const, icloudCredentials: sealed };
    this.ctx.storage.transactionSync(() => {
      this.db.insert(schema.profile).values({ id: 1, ...values }).onConflictDoUpdate({ target: schema.profile.id, set: values }).run();
      this.db.delete(schema.categories).run();
      this.db.insert(schema.categories).values(rows).run();
    });

    // Local events → iCloud. Idempotent per event (sourceMessageId), local
    // rows removed only once every one of them is in iCloud.
    const p = await this.profile();
    const ctx = await this.appCtx(p);
    for (const r of local) {
      const allDay = r.allDay;
      const ev = await ctx.store.createEvent({
        title: r.title,
        start: allDay ? localDate(r.startAt, ctx.tz) : localDateTime(r.startAt, ctx.tz),
        end: allDay ? localDate(new Date(r.endAt.getTime() - 1), ctx.tz) : localDateTime(r.endAt, ctx.tz),
        allDay,
        category: oldCats.find((c) => c.id === r.categoryId)?.slug ?? null,
        location: r.location,
        notes: r.notes,
        recurrence: r.recurrence,
        reminderMinutes: r.reminderMinutes,
        sourceMessageId: `moved:${r.id}`,
      });
      for (const ex of r.exdates) await ctx.store.deleteEvent(ev.id, new Date(ex));
    }
    if (local.length) await this.db.delete(schema.events);

    if (!before || before.storage === "local" || before.phone !== values.phone) {
      const first = m.name?.split(" ")[0];
      await this.db
        .insert(inboundMessages)
        .values({
          messageId: `icloud-connected:${Date.now()}`,
          phone: m.phone,
          text: "",
          status: "answered",
          reply: `📅 ${first ? `${first}, sua` : "Sua"} agenda do iCloud está conectada! O que você marcar aqui aparece no Calendário do iPhone, e o que você marcar lá eu também vejo.

Categorias: ${rows.map((r) => `${r.emoji} ${r.name}`).join(", ")}.

Tenta: _dentista sexta 15h_ · _o que tenho amanhã?_`,
        })
        .onConflictDoNothing();
      this.kicked = true;
    }
    const nextAlarm = await this.reschedule().catch((err) => `not rescheduled: ${err}`);
    return { categories: rows.length, movedEvents: local.length, nextAlarm };
  }

  /* ------------------------ registry (object "registry") ------------------- */

  registryFind(phone: string) {
    return findUser(this.sqlDb, phone);
  }
  registryAdd(phone: string, name: string | null) {
    return addUser(this.sqlDb, phone, name);
  }
  registryByToken(token: string) {
    return findUserByToken(this.sqlDb, token);
  }
  registryList() {
    return listUsers(this.sqlDb);
  }
  registryRemove(phone: string) {
    return removeUser(this.sqlDb, phone);
  }
  signupRequest(phone: string) {
    return requestCode(this.sqlDb, phone);
  }
  signupCancel(phone: string) {
    return cancelCode(this.sqlDb, phone);
  }
  signupVerify(phone: string, code: string) {
    return verifyCode(this.sqlDb, phone, code);
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

  /** Replace the category → calendar mapping (pnpm configure). */
  async debugSetCategories(list: CategoryConfig[]) {
    const { rows, defaultSlug } = categoryRows(list);
    // Atomic: either the whole new mapping is in place or the old one stays.
    this.ctx.storage.transactionSync(() => {
      this.db.delete(schema.categories).run();
      this.db.insert(schema.categories).values(rows).run();
    });
    const result = { categories: rows.length, default: defaultSlug };
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

/** The owner's object ("main": iCloud). With a phone: that user's object. */
export function scheduler(env: Env, phone?: string | null) {
  const name = !phone || samePhone(phone, env.OWNER_PHONE) ? "main" : `user:${canonPhone(phone)}`;
  return env.SCHEDULER.get(env.SCHEDULER.idFromName(name));
}

/** Who may talk to the bot (besides the owner) and their feed tokens. */
export function registry(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("registry"));
}

