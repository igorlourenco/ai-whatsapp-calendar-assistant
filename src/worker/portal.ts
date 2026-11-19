import { Hono, type Context } from "hono";

import { suggestEmoji } from "./calendar/emoji";
import { slugify } from "./calendar/store";
import { settings, validTimezone } from "./config";
import type { CategoryConfig } from "./debug";
import { calendarHome, listCalendars } from "./icloud/caldav";
import { portalPage } from "./portal-page";
import { registry, scheduler } from "./scheduler";
import { createSession, readSession } from "./session";
import { parsePhone } from "./signup";
import { welcome } from "./users";
import { canonPhone, samePhone, sendText } from "./zapi";

/*
 * Signup / account page (GET /), open to anyone:
 *
 * 1. Number → the bot sends a 6-digit code there (POST /signup/code).
 * 2. Code → a 30-min session for that number (POST /signup/verify). It works
 *    as login too: an existing user lands on their account.
 * 3. New users pick where their agenda lives: in the bot, shown read-only on
 *    the phone through a calendar link (POST /account/guest), or their own
 *    iCloud, two-way (POST /account/icloud/calendars, then /account/icloud).
 *    Existing users can switch to iCloud, or delete their account
 *    (POST /account/delete).
 *
 * Optional Cloudflare Turnstile: set TURNSTILE_SITE_KEY + TURNSTILE_SECRET.
 */

type PortalEnv = Env & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string; SIGNUP_LIMIT?: RateLimit };
type C = Context<{ Bindings: PortalEnv }>;

export const portal = new Hono<{ Bindings: PortalEnv }>();

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

portal.get("/", (c) => c.html(portalPage({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null }), 200, SECURITY_HEADERS));

const err = (c: Context, message: string, status: 400 | 401 | 403 | 429 | 502 = 400) => c.json({ ok: false, error: message }, status);

const clientIp = (c: Context) => c.req.header("CF-Connecting-IP") ?? "unknown";

/** Per-IP limiter (wrangler.jsonc "ratelimits"). Missing binding (tests, dev) → allowed. */
async function ipAllowed(env: PortalEnv, ip: string): Promise<boolean> {
  if (!env.SIGNUP_LIMIT) return true;
  return (await env.SIGNUP_LIMIT.limit({ key: ip })).success;
}

portal.use("/signup/*", async (c, next) => {
  if (!(await ipAllowed(c.env, clientIp(c)))) return err(c, "Muitas tentativas. Espera um minuto e tenta de novo.", 429);
  await next();
});
portal.use("/account/*", async (c, next) => {
  if (!(await ipAllowed(c.env, clientIp(c)))) return err(c, "Muitas tentativas. Espera um minuto e tenta de novo.", 429);
  await next();
});

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

/** Trimmed, no control/markdown chars, ≤ max chars. */
function cleanText(v: unknown, max = 60): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\p{C}*_~`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

type Body = Record<string, unknown>;
const json = async (c: Context) => ((await c.req.json<Body>().catch(() => ({}))) ?? {}) as Body;

/* ------------------------------ login code ------------------------------ */

/** Step 1: send a code to the number on WhatsApp. */
portal.post("/signup/code", async (c) => {
  const body = await json(c);
  const phone = parsePhone(str(body.phone));
  if (!phone) return err(c, "Esse número não parece certo. Usa DDD + número, ou +código do país.");
  if (!(await turnstileOk(c.env, str(body.turnstile) || undefined, clientIp(c)))) {
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

/** Step 2: the code proves the number → session + the account, if any. */
portal.post("/signup/verify", async (c) => {
  const body = await json(c);
  const phone = parsePhone(str(body.phone));
  if (!phone) return err(c, "Número inválido. Volta e confere.");
  if (samePhone(phone, c.env.OWNER_PHONE)) return err(c, "Esse é o número do administrador: a conta dele se configura pelo terminal.", 403);

  const check = await registry(c.env).signupVerify(phone, str(body.code));
  if (check === "wrong") return err(c, "Código errado. Confere a mensagem no WhatsApp.");
  if (check === "locked") return err(c, "Errou o código vezes demais. Pede um novo.", 429);
  if (check === "expired") return err(c, "Esse código expirou. Pede um novo.");

  return c.json({ ok: true, token: await createSession(c.env.CREDENTIALS_KEY, phone), account: await account(c, phone) });
});

/* ------------------------------- account -------------------------------- */

type Account = { name: string | null; storage: "icloud" | "local"; feedUrl: string | null; httpsUrl: string | null };

/** What the page shows for this number, or null when it has no account yet. */
async function account(c: C, phone: string): Promise<Account | null> {
  const user = await registry(c.env).registryFind(phone);
  if (!user) return null;
  const summary = await scheduler(c.env, phone).accountSummary();
  const host = new URL(c.req.url).host;
  const local = summary?.storage !== "icloud";
  return {
    name: summary?.name ?? user.name,
    storage: local ? "local" : "icloud",
    feedUrl: local ? `webcal://${host}/cal/${user.icsToken}.ics` : null,
    httpsUrl: local ? `https://${host}/cal/${user.icsToken}.ics` : null,
  };
}

/** The session's phone, or null (→ the handler answers 401). */
async function sessionPhone(c: C): Promise<string | null> {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  const phone = await readSession(c.env.CREDENTIALS_KEY, token);
  return phone && !samePhone(phone, c.env.OWNER_PHONE) ? phone : null;
}

const EXPIRED = "Sua sessão expirou. Entra de novo com o código do WhatsApp.";

/** The browser's time zone, only when valid and different from the deployment's. */
function userTz(c: C, v: unknown): string | null {
  return typeof v === "string" && validTimezone(v) && v !== settings(c.env).tz ? v : null;
}

/** New account with the agenda in the bot (same as joining with the invite code). */
portal.post("/account/guest", async (c) => {
  const phone = await sessionPhone(c);
  if (!phone) return err(c, EXPIRED, 401);
  const body = await json(c);
  const reg = registry(c.env);
  if (!(await reg.registryFind(phone))) {
    const name = cleanText(body.name);
    const user = await reg.registryAdd(phone, name);
    const feedUrl = `webcal://${new URL(c.req.url).host}/cal/${user.icsToken}.ics`;
    try {
      await scheduler(c.env, phone).join({
        messageId: `signup:${canonPhone(phone)}:${Date.now()}`,
        phone,
        name,
        feedUrl,
        tz: userTz(c, body.tz),
        welcome: welcome(c.env, name, feedUrl),
      });
    } catch (e) {
      // Never leave a registered number with an empty object.
      await reg.registryRemove(phone);
      console.error("[signup] join failed", canonPhone(phone), e);
      return err(c, "Não consegui criar sua agenda agora. Tenta de novo em alguns minutos.", 502);
    }
    console.log("[signup] new user", canonPhone(phone));
  }
  return c.json({ ok: true, account: await account(c, phone) });
});

type ICloudLogin = { username: string; password: string };

function icloudLogin(body: Body): ICloudLogin | null {
  const username = str(body.username).trim();
  const password = str(body.password).replace(/\s+/g, "");
  if (!/^\S+@\S+\.\S+$/.test(username) || username.length > 200) return null;
  if (!/^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/i.test(password)) return null;
  return { username, password: password.includes("-") ? password : password.replace(/(.{4})(?=.)/g, "$1-") };
}

const BAD_LOGIN = "O iCloud não aceitou. Confere o Apple ID e usa uma senha de app (xxxx-xxxx-xxxx-xxxx), não a senha normal.";

async function icloudCalendars(login: ICloudLogin) {
  const account = { ICLOUD_USERNAME: login.username, ICLOUD_APP_PASSWORD: login.password };
  return listCalendars(account, await calendarHome(account));
}

/** Check the iCloud login and list its calendars, with a suggested emoji each. */
portal.post("/account/icloud/calendars", async (c) => {
  const phone = await sessionPhone(c);
  if (!phone) return err(c, EXPIRED, 401);
  const login = icloudLogin(await json(c));
  if (!login) return err(c, BAD_LOGIN);
  try {
    const cals = await icloudCalendars(login);
    if (!cals.length) return err(c, "Essa conta do iCloud não tem nenhum calendário de eventos.");
    return c.json({ ok: true, calendars: cals.map((k) => ({ url: k.url, name: k.name, color: k.color, emoji: suggestEmoji(k.name) })) });
  } catch (e) {
    console.warn("[signup] icloud login failed", canonPhone(phone), e instanceof Error ? e.message : e);
    return err(c, BAD_LOGIN);
  }
});

/** Connect (or reconnect) the user's iCloud with the calendars they picked. */
portal.post("/account/icloud", async (c) => {
  const phone = await sessionPhone(c);
  if (!phone) return err(c, EXPIRED, 401);
  const body = await json(c);
  const login = icloudLogin(body);
  if (!login) return err(c, BAD_LOGIN);
  const picked = Array.isArray(body.categories) ? (body.categories as Body[]).slice(0, 20) : [];
  if (!picked.length) return err(c, "Escolhe pelo menos um calendário.");

  let cals;
  try {
    cals = await icloudCalendars(login);
  } catch {
    return err(c, BAD_LOGIN);
  }
  // Only this account's own calendars: never a URL taken from the request.
  const categories: CategoryConfig[] = [];
  for (const p of picked) {
    const cal = cals.find((k) => k.url === str(p.url));
    if (!cal) return err(c, "Um dos calendários escolhidos não existe mais. Recarrega a lista.");
    const name = cleanText(p.name, 40) ?? cal.name;
    const slug = slugify(name);
    if (!slug) return err(c, `Dá um nome com letras pro calendário "${cal.name}".`);
    if (categories.some((x) => x.slug === slug)) return err(c, `Dois calendários ficaram com o nome "${name}". Muda um deles.`);
    const emoji = str(p.emoji).trim().slice(0, 16) || suggestEmoji(name);
    categories.push({
      slug,
      name,
      emoji,
      calendarUrl: cal.url,
      color: cal.color,
      description: cleanText(p.description, 120),
      isDefault: p.isDefault === true,
    });
  }

  const reg = registry(c.env);
  const existing = await reg.registryFind(phone);
  const name = cleanText(body.name) ?? existing?.name ?? null;
  try {
    await reg.registryAdd(phone, name);
    await scheduler(c.env, phone).connectICloud({ phone, name, ...login, categories, tz: userTz(c, body.tz) });
  } catch (e) {
    // A new number whose object never got set up must not stay registered.
    if (!existing && !(await scheduler(c.env, phone).accountSummary())) await reg.registryRemove(phone);
    console.error("[signup] icloud connect failed", canonPhone(phone), e);
    return err(c, "Não consegui conectar ao iCloud agora. Tenta de novo em alguns minutos.", 502);
  }
  console.log("[signup] icloud connected", canonPhone(phone), existing ? "(existing)" : "(new)");
  return c.json({ ok: true, account: await account(c, phone) });
});

/** Delete the account: the user's object is wiped and the number unregistered. */
portal.post("/account/delete", async (c) => {
  const phone = await sessionPhone(c);
  if (!phone) return err(c, EXPIRED, 401);
  if (str((await json(c)).confirm) !== "excluir") return err(c, 'Confirma escrevendo "excluir".');
  const removed = await registry(c.env).registryRemove(phone);
  await scheduler(c.env, phone).wipe();
  console.log("[signup] account deleted", canonPhone(phone), removed);
  return c.json({ ok: true });
});
