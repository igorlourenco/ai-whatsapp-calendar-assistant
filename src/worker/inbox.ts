import { asc, eq, inArray } from "drizzle-orm";

import { inboundMessages, messageEvents } from "./db/schema";
import type { AppCtx, Incoming } from "./llm/execute";

/** Attempts per message before telling the user it failed. */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [15_000, 60_000];
/** Messages handled per run (each may take a few LLM round-trips). */
const INBOX_BATCH = 10;

export const OPEN_STATUSES = ["pending", "answered"] as const;

export type InboxDeps = {
  /** Run the assistant on a message; returns the reply text. */
  handle: (ctx: AppCtx, msg: Incoming) => Promise<string>;
  send: (phone: string, message: string) => Promise<void>;
  now?: () => number;
};

type Row = typeof inboundMessages.$inferSelect;

/**
 * Process open inbox rows strictly in arrival order. Stops at the first row
 * still waiting on backoff, so a later "muda pra 15h" never runs before the
 * "salva X" it refers to.
 */
export async function processInbox(ctx: AppCtx, deps: InboxDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  for (let i = 0; i < INBOX_BATCH; i++) {
    const [row] = await ctx.db
      .select()
      .from(inboundMessages)
      .where(inArray(inboundMessages.status, [...OPEN_STATUSES]))
      .orderBy(asc(inboundMessages.receivedAt))
      .limit(1);
    if (!row || row.nextAttemptAt.getTime() > now()) return;
    await processOne(ctx, deps, row, now);
  }
}

/*
 * pending ──LLM──▶ answered (reply stored) ──send──▶ done
 * Reply is stored before sending, so a send retry never re-runs the LLM.
 * LLM retries are safe: creates are idempotent on source_message_id.
 */
async function processOne(ctx: AppCtx, deps: InboxDeps, row: Row, now: () => number) {
  const where = eq(inboundMessages.messageId, row.messageId);
  try {
    let reply = row.reply;
    if (row.status === "pending" || reply == null) {
      reply =
        row.text.trim() || row.mediaUrl
          ? await deps.handle(
              { ...ctx, sourceMessageId: row.messageId },
              { text: row.text.trim(), mediaUrl: row.mediaUrl, mediaMime: row.mediaMime },
            )
          : "Por enquanto entendo texto, áudio e imagens 🙏";
      await ctx.db.update(inboundMessages).set({ status: "answered", reply }).where(where);
    }
    await deps.send(row.phone, reply);
    await ctx.db
      .update(inboundMessages)
      .set({ status: "done", processedAt: new Date(now()), lastError: null })
      .where(where);
  } catch (err) {
    const attempts = row.attempts + 1;
    const lastError = String(err instanceof Error ? err.message : err).slice(0, 1000);
    console.error("[inbox] message failed", { messageId: row.messageId, attempts, lastError });

    if (attempts < MAX_ATTEMPTS) {
      await ctx.db
        .update(inboundMessages)
        .set({
          attempts,
          lastError,
          nextAttemptAt: new Date(now() + (BACKOFF_MS[attempts - 1] ?? 60_000)),
        })
        .where(where);
      return;
    }
    await ctx.db
      .update(inboundMessages)
      .set({ attempts, lastError, status: "failed", processedAt: new Date(now()) })
      .where(where);
    await deps
      .send(row.phone, await failureNotice(ctx, row))
      .catch((e) => console.error("[inbox] failure notice not sent", e));
  }
}

/** Tell the user exactly what did and didn't get saved. */
export async function failureNotice(ctx: AppCtx, row: Row): Promise<string> {
  const media = row.mediaMime?.startsWith("audio/") ? "🎤 áudio" : "📷 imagem";
  const body = row.text || (row.mediaUrl ? media : "");
  const quoted = body.length > 160 ? `${body.slice(0, 160)}…` : body;
  const saved = await ctx.db
    .select({ label: messageEvents.label })
    .from(messageEvents)
    .where(eq(messageEvents.messageId, row.messageId));
  const savedNote = saved.length
    ? `Isto chegou a ser salvo:\n${saved.map((s) => `• ${s.label}`).join("\n")}`
    : "*Nada dela foi salvo.*";
  return `⚠️ *Não consegui processar sua mensagem*\n_"${quoted}"_\n\n${savedNote}\n\nPode mandar de novo?`;
}
