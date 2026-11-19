import { Hono, type Context } from "hono";

import { settings, validTimezone } from "./config";
import { portalPage } from "./portal-page";
import { registry, scheduler } from "./scheduler";
import { parsePhone } from "./signup";
import { welcome } from "./users";
import { canonPhone, samePhone, sendText } from "./zapi";

/*
 * Signup page (GET /), open to anyone: name + WhatsApp number → the bot sends
 * a 6-digit code there → the code creates the user (same as sending
 * INVITE_CODE on WhatsApp: agenda in the bot, read-only calendar link).
 *
 * Optional Cloudflare Turnstile: set TURNSTILE_SITE_KEY + TURNSTILE_SECRET.
 */

type PortalEnv = Env & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string; SIGNUP_LIMIT?: RateLimit };

export const portal = new Hono<{ Bindings: PortalEnv }>();

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

portal.get("/", (c) => c.html(portalPage({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null }), 200, SECURITY_HEADERS));

const err = (c: Context, message: string, status: 400 | 403 | 429 | 502 = 400) => c.json({ ok: false, error: message }, status);

const clientIp = (c: Context) => c.req.header("CF-Connecting-IP") ?? "unknown";

/** Per-IP limiter (wrangler.jsonc "ratelimits"). Missing binding (tests, dev) → allowed. */
async function ipAllowed(env: PortalEnv, ip: string): Promise<boolean> {
  if (!env.SIGNUP_LIMIT) return true;
  return (await env.SIGNUP_LIMIT.limit({ key: ip })).success;
}

async function turnstileOk(env: PortalEnv, token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = (await res.json().catch(() => ({}))) as { success?: boolean };
  return out.success === true;
}

/** Trimmed, no control chars, ≤ 60 chars. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\p{C}*_~`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || null;
}

type Body = { name?: unknown; phone?: unknown; code?: unknown; tz?: unknown; turnstile?: unknown };

/** Step 1: send a code to the number on WhatsApp. */
portal.post("/signup/code", async (c) => {
  const ip = clientIp(c);
  if (!(await ipAllowed(c.env, ip))) return err(c, "Muitas tentativas. Espera um minuto e tenta de novo.", 429);
  const body = (await c.req.json<Body>().catch(() => ({}))) as Body;
  const name = cleanName(body.name);
  const phone = typeof body.phone === "string" ? parsePhone(body.phone) : null;
  if (!name) return err(c, "Diz teu nome.");
  if (!phone) return err(c, "Esse número não parece certo. Usa DDD + número, ou +código do país.");
  if (!(await turnstileOk(c.env, typeof body.turnstile === "string" ? body.turnstile : undefined, ip))) {
    return err(c, "Não deu pra confirmar que você é uma pessoa. Recarrega a página e tenta de novo.", 403);
  }

  const reg = registry(c.env);
  const req = await reg.signupRequest(phone);
  if (!req.ok) {
    if (req.reason === "wait") return err(c, `Já mandei um código. Pra mandar outro, espera ${req.seconds} s.`, 429);
    if (req.reason === "limit") return err(c, "Esse número já pediu códigos demais hoje. Tenta amanhã.", 429);
    return err(c, "Muita gente se cadastrando agora. Tenta de novo mais tarde.", 429);
  }
  try {
    await sendText(
      c.env,
      phone,
      `🔐 Seu código pra entrar na agenda: *${req.code}*\n\nVale por 10 minutos. Se não foi você que pediu, ignora esta mensagem.`,
    );
  } catch (e) {
    console.error("[signup] send failed", canonPhone(phone), e);
    await reg.signupCancel(phone);
    return err(c, "Não consegui mandar a mensagem pra esse número. Ele tem WhatsApp?", 502);
  }
  console.log("[signup] code sent", canonPhone(phone));
  return c.json({ ok: true, phone });
});

/** Step 2: the code proves the number → user created, welcome sent on WhatsApp. */
portal.post("/signup/verify", async (c) => {
  if (!(await ipAllowed(c.env, clientIp(c)))) return err(c, "Muitas tentativas. Espera um minuto e tenta de novo.", 429);
  const body = (await c.req.json<Body>().catch(() => ({}))) as Body;
  const name = cleanName(body.name);
  const phone = typeof body.phone === "string" ? parsePhone(body.phone) : null;
  const code = typeof body.code === "string" ? body.code : "";
  if (!phone) return err(c, "Número inválido. Volta e confere.");

  const reg = registry(c.env);
  const check = await reg.signupVerify(phone, code);
  if (check === "wrong") return err(c, "Código errado. Confere a mensagem no WhatsApp.");
  if (check === "locked") return err(c, "Errou o código vezes demais. Pede um novo.", 429);
  if (check === "expired") return err(c, "Esse código expirou. Pede um novo.");

  const host = new URL(c.req.url).host;
  const done = (feedToken: string | null, existing: boolean) =>
    c.json({
      ok: true,
      existing,
      feedUrl: feedToken ? `webcal://${host}/cal/${feedToken}.ics` : null,
      httpsUrl: feedToken ? `https://${host}/cal/${feedToken}.ics` : null,
    });

  // The owner (and anyone on their own iCloud) already sees the agenda in Apple Calendar.
  if (samePhone(phone, c.env.OWNER_PHONE)) return done(null, true);
  const existing = await reg.registryFind(phone);
  if (existing) {
    const kind = await scheduler(c.env, phone).storageKind();
    return done(kind === "local" ? existing.icsToken : null, true);
  }

  const user = await reg.registryAdd(phone, name);
  const feedUrl = `webcal://${host}/cal/${user.icsToken}.ics`;
  const tz = typeof body.tz === "string" && validTimezone(body.tz) && body.tz !== settings(c.env).tz ? body.tz : null;
  await scheduler(c.env, phone).join({
    messageId: `signup:${canonPhone(phone)}`,
    phone,
    name,
    feedUrl,
    tz,
    welcome: welcome(c.env, name, feedUrl),
  });
  console.log("[signup] new user", canonPhone(phone));
  return done(user.icsToken, false);
});
