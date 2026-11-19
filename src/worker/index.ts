import { Hono, type Context } from "hono";

import type { CategoryConfig, ExportData } from "./debug";
import { portal } from "./portal";
import { registry, scheduler, type Inbound } from "./scheduler";
import { hasInvite, welcome } from "./users";
import { loginCodeIn } from "./signup";
import { canonPhone, samePhone, sendText, type ZapiReceived } from "./zapi";

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
  const msg: Inbound = {
    messageId: body.messageId ?? `noid:${body.phone}:${body.momment ?? Date.now()}`,
    phone: body.phone,
    text: body.text?.message ?? body.image?.caption ?? body.document?.caption ?? "",
    // Photos, voice notes, and files sent "as document" (uncompressed images,
    // audio files). Other files (PDF…) are stored too so the bot can say it
    // can't read them yet.
    mediaUrl: body.image?.imageUrl ?? body.audio?.audioUrl ?? body.document?.documentUrl ?? null,
    mediaMime: body.image
      ? (body.image.mimeType ?? "image/jpeg")
      : body.audio?.audioUrl
        ? (body.audio.mimeType ?? "audio/ogg")
        : (body.document?.mimeType ?? null),
  };

  // Durable inbox: the user's Durable Object stores the message (idempotent
  // on messageId) before we ack, then processes it with retries. If that
  // fails we return 500 so Z-API redelivers.
  try {
    // Signup page login ("Entrar na agenda: K7M2QX"): bind this number to the
    // page that showed the code. Answered here, never seen by the model.
    const login = samePhone(body.phone, env.OWNER_PHONE) ? null : loginCodeIn(msg.text);
    if (login && (await registry(env).loginClaim(login, body.phone))) {
      await sendText(env, body.phone, "✅ Pronto! Volta pra página pra continuar.\n\nSe não foi você que abriu a página, ignora esta mensagem.").catch((err) =>
        console.error("[webhook] login reply failed", err),
      );
      console.log("[webhook] login claimed", canonPhone(body.phone));
      return c.json({ ok: true, login: true });
    }
    if (!samePhone(body.phone, env.OWNER_PHONE)) {
      // Everyone else: registered users, or someone sending the invite code.
      // Anyone else is ignored without touching their object.
      const reg = registry(env);
      const known = await reg.registryFind(body.phone);
      if (!known) {
        if (!hasInvite(msg.text, env.INVITE_CODE)) return c.json({ ok: true, ignored: "sender" });
        const name = body.senderName?.trim() || null;
        const user = await reg.registryAdd(body.phone, name);
        const feedUrl = `webcal://${new URL(c.req.url).host}/cal/${user.icsToken}.ics`;
        await scheduler(env, body.phone).join({ messageId: msg.messageId, phone: body.phone, name, feedUrl, welcome: welcome(env, name, feedUrl) });
        console.log("[webhook] new user", canonPhone(body.phone));
        return c.json({ ok: true, joined: true });
      }
    }
    await scheduler(env, body.phone).enqueue(msg);
  } catch (err) {
    console.error("[webhook] enqueue failed", err);
    return c.json({ ok: false }, 500);
  }
  return c.json({ ok: true });
});

/* --------------------------- Calendar feeds ---------------------------- */
// Read-only ICS for users without iCloud. The token in the URL is the secret.

app.get("/cal/:file", async (c) => {
  const token = c.req.param("file").replace(/\.ics$/, "");
  const user = await registry(c.env).registryByToken(token);
  if (!user) return c.text("not found", 404);
  const ics = await scheduler(c.env, user.phone).feed();
  if (!ics) return c.text("not found", 404);
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "private, max-age=300",
  });
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

app.get("/debug/users", async (c) => c.json(await registry(c.env).registryList()));

/** Connect a user's own iCloud (pnpm connect-icloud). Registers them if needed. */
app.put("/debug/icloud", async (c) => {
  const phone = c.req.query("user");
  if (!phone) return c.json({ error: "?user=<phone> required" }, 400);
  if (samePhone(phone, c.env.OWNER_PHONE)) return c.json({ error: "the owner's iCloud comes from ICLOUD_* (pnpm configure)" }, 400);
  const body = await c.req.json<{ name?: string; username: string; password: string; categories: CategoryConfig[] }>();
  try {
    await registry(c.env).registryAdd(phone, body.name ?? null);
    return c.json(await scheduler(c.env, phone).connectICloud({ phone, name: body.name ?? null, ...body }));
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/debug/users/:phone", async (c) => c.json({ removed: await registry(c.env).registryRemove(c.req.param("phone")) }));

app.get("/debug/state", async (c) => c.json(await scheduler(c.env, c.req.query("user")).debugSnapshot()));

app.post("/debug/query", async (c) => {
  const { sql } = await c.req.json<{ sql: string }>();
  try {
    return c.json(await scheduler(c.env, c.req.query("user")).debugQuery(sql));
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/debug/export", async (c) => c.json(await scheduler(c.env, c.req.query("user")).debugExport()));

app.post("/debug/import", async (c) => {
  try {
    return c.json(await scheduler(c.env, c.req.query("user")).debugImport(await c.req.json<ExportData>()));
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/debug/categories", async (c) => {
  try {
    return c.json(await scheduler(c.env, c.req.query("user")).debugSetCategories(await c.req.json<CategoryConfig[]>()));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/debug/restore", async (c) => {
  const { at, confirm } = await c.req.json<{ at: string; confirm?: string }>();
  if (confirm !== "restore") return c.json({ error: 'send {"at": "<ISO time>", "confirm": "restore"}' }, 400);
  try {
    return c.json({ ok: true, ...(await scheduler(c.env, c.req.query("user")).debugRestore(at)) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ------------------------------- Signup -------------------------------- */
// Open signup page at "/" (see portal.ts).

app.route("/", portal);

app.all("*", (c) => c.text("not found", 404));

/* -------------------------------- Worker ------------------------------- */

export default {
  fetch: app.fetch,
  // Daily watchdog only: arms each user's alarm if none is pending (first
  // deploy, or storage reset). All real timing lives in the Scheduler DOs.
  async scheduled(_controller, env, ctx) {
    const arm = (phone: string | null) =>
      scheduler(env, phone)
        .ensureArmed()
        .then((at) => console.log("[watchdog] next wake", phone ?? "owner", at))
        .catch((err) => console.error("[watchdog] failed", phone ?? "owner", err));
    ctx.waitUntil(
      (async () => {
        await arm(null);
        for (const u of await registry(env).registryList()) await arm(u.phone);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

export { Scheduler } from "./scheduler";
