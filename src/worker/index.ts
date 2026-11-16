import { Hono, type Context } from "hono";

import type { CategoryConfig, ExportData } from "./debug";
import { scheduler } from "./scheduler";
import { samePhone, type ZapiReceived } from "./zapi";

const app = new Hono<{ Bindings: Env }>();

/* ------------------------------ WhatsApp ------------------------------- */

app.post("/webhooks/zapi", async (c) => {
  const env = c.env;
  if (c.req.query("token") !== env.ZAPI_WEBHOOK_TOKEN) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as ZapiReceived | null;
  if (!body || body.type !== "ReceivedCallback") return c.json({ ok: true, ignored: "type" });
  if (body.fromMe || body.isGroup || body.isNewsletter || body.broadcast || !body.phone) {
    return c.json({ ok: true, ignored: "kind" });
  }
  // The Z-API instance may be shared with another app/number: only
  // OWNER_PHONE gets the assistant, every other sender is ignored.
  if (!samePhone(body.phone, env.OWNER_PHONE)) return c.json({ ok: true, ignored: "sender" });

  // Durable inbox: the Durable Object stores the message (idempotent on
  // messageId) before we ack, then processes it with retries. If that fails
  // we return 500 so Z-API redelivers.
  try {
    await scheduler(env).enqueue({
      messageId: body.messageId ?? `noid:${body.phone}:${body.momment ?? Date.now()}`,
      phone: body.phone,
      text: body.text?.message ?? body.image?.caption ?? body.document?.caption ?? "",
      // Photos, and images sent "as document" (uncompressed). Other files
      // (PDF…) are stored too so the bot can say it can't read them yet.
      mediaUrl: body.image?.imageUrl ?? body.document?.documentUrl ?? null,
      mediaMime: body.image ? (body.image.mimeType ?? "image/jpeg") : (body.document?.mimeType ?? null),
    });
  } catch (err) {
    console.error("[webhook] enqueue failed", err);
    return c.json({ ok: false }, 500);
  }
  return c.json({ ok: true });
});

/* ------------------------------- Debug --------------------------------- */
// Inspection/ops for the Durable Object's SQLite. Bearer DEBUG_TOKEN.

async function timingSafeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  // Workers-specific extension of SubtleCrypto (not in the DOM lib types).
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(ha, hb);
}

app.use("/debug/*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!c.env.DEBUG_TOKEN || !(await timingSafeEqual(token, c.env.DEBUG_TOKEN))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

const fail = (c: Context, err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 400);

app.get("/debug/state", async (c) => c.json(await scheduler(c.env).debugSnapshot()));

app.post("/debug/query", async (c) => {
  const { sql } = await c.req.json<{ sql: string }>();
  try {
    return c.json(await scheduler(c.env).debugQuery(sql));
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/debug/export", async (c) => c.json(await scheduler(c.env).debugExport()));

app.post("/debug/import", async (c) => {
  try {
    return c.json(await scheduler(c.env).debugImport(await c.req.json<ExportData>()));
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/debug/categories", async (c) => {
  try {
    return c.json(await scheduler(c.env).debugSetCategories(await c.req.json<CategoryConfig[]>()));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/debug/restore", async (c) => {
  const { at, confirm } = await c.req.json<{ at: string; confirm?: string }>();
  if (confirm !== "restore") return c.json({ error: 'send {"at": "<ISO time>", "confirm": "restore"}' }, 400);
  try {
    return c.json({ ok: true, ...(await scheduler(c.env).debugRestore(at)) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.all("*", (c) => c.text("not found", 404));

/* -------------------------------- Worker ------------------------------- */

export default {
  fetch: app.fetch,
  // Daily watchdog only: arms the scheduler alarm if none is pending (first
  // deploy, or storage reset). All real timing lives in the Scheduler DO.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      scheduler(env)
        .ensureArmed()
        .then((at) => console.log("[watchdog] next wake", at))
        .catch((err) => console.error("[watchdog] failed", err)),
    );
  },
} satisfies ExportedHandler<Env>;

export { Scheduler } from "./scheduler";
