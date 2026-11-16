import { Hono } from "hono";

import { getDb } from "./db/client";
import { inboundMessages } from "./db/schema";
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
  // Shared Movisim instance: every customer message lands here too. Only the
  // owner gets the assistant; everyone else is left for the human inbox.
  if (!samePhone(body.phone, env.OWNER_PHONE)) return c.json({ ok: true, ignored: "sender" });

  // Durable inbox: store, wake the Scheduler DO, ack. The DO does the LLM
  // work with retries, so a slow model or an iCloud/Neon/Z-API blip never
  // loses a message. If storing or waking fails we return 500 so Z-API
  // redelivers (the insert is idempotent on messageId).
  const messageId = body.messageId ?? `noid:${body.phone}:${body.momment ?? Date.now()}`;
  const text = body.text?.message ?? body.image?.caption ?? "";
  try {
    await getDb(env)
      .insert(inboundMessages)
      .values({ messageId, phone: body.phone, text, status: "pending" })
      .onConflictDoNothing();
    await scheduler(env).kick();
  } catch (err) {
    console.error("[webhook] enqueue failed", err);
    return c.json({ ok: false }, 500);
  }
  return c.json({ ok: true });
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
