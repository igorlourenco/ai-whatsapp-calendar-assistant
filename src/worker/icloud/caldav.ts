/**
 * Minimal CalDAV client for iCloud (RFC 4791), fetch-only so it runs on
 * Workers. Auth: Apple ID + app-specific password (Basic).
 */

export type ICloudEnv = { ICLOUD_USERNAME: string; ICLOUD_APP_PASSWORD: string };

export type RemoteCalendar = { name: string; url: string; color: string | null };
export type RemoteObject = { href: string; etag: string; ics: string };

const ROOT = "https://caldav.icloud.com/";

function authHeader(env: ICloudEnv) {
  return `Basic ${btoa(`${env.ICLOUD_USERNAME}:${env.ICLOUD_APP_PASSWORD}`)}`;
}

async function dav(
  env: ICloudEnv,
  method: string,
  url: string,
  opts: { depth?: 0 | 1; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(env),
      ...(opts.depth !== undefined ? { Depth: String(opts.depth) } : {}),
      ...(opts.body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
      ...opts.headers,
    },
    body: opts.body,
  });
  if (res.status === 401) throw new Error("iCloud recusou a senha de app (401)");
  return res;
}

/* ------------------------------- XML bits ------------------------------- */

function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}
const first = (xml: string, name: string) => tags(xml, name)[0];

function unescapeXml(s: string): string {
  return s
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, "\r")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/* ------------------------------ discovery ------------------------------- */

export async function calendarHome(env: ICloudEnv): Promise<string> {
  const r1 = await dav(env, "PROPFIND", ROOT, {
    depth: 0,
    body: `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
  });
  const principal = first(first(await r1.text(), "current-user-principal") ?? "", "href");
  if (!principal) throw new Error("iCloud: principal not found");
  const r2 = await dav(env, "PROPFIND", new URL(principal, ROOT).href, {
    depth: 0,
    body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
  });
  const home = first(first(await r2.text(), "calendar-home-set") ?? "", "href");
  if (!home) throw new Error("iCloud: calendar home not found");
  return new URL(home, ROOT).href;
}

/** Event calendars (VEVENT) under the home. */
export async function listCalendars(env: ICloudEnv, home: string): Promise<RemoteCalendar[]> {
  const res = await dav(env, "PROPFIND", home, {
    depth: 1,
    body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
  });
  const out: RemoteCalendar[] = [];
  for (const resp of tags(await res.text(), "response")) {
    const rt = first(resp, "resourcetype") ?? "";
    const comps = [...resp.matchAll(/comp\s+name=["'](\w+)["']/g)].map((m) => m[1]);
    if (!/calendar/i.test(rt) || !comps.includes("VEVENT")) continue;
    const href = first(resp, "href");
    const name = first(resp, "displayname");
    if (!href || !name) continue;
    const color = first(resp, "calendar-color")?.slice(0, 7) ?? null;
    out.push({ name: unescapeXml(name), url: new URL(href, home).href, color });
  }
  return out;
}

/* ------------------------------- objects -------------------------------- */

const caldavUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** All event objects with an occurrence overlapping [from, to) (recurring ones included whole). */
export async function queryEvents(env: ICloudEnv, calendarUrl: string, from: Date, to: Date): Promise<RemoteObject[]> {
  const res = await dav(env, "REPORT", calendarUrl, {
    depth: 1,
    body: `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${caldavUtc(from)}" end="${caldavUtc(to)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`,
  });
  if (res.status !== 207) throw new Error(`iCloud REPORT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out: RemoteObject[] = [];
  for (const resp of tags(await res.text(), "response")) {
    const href = first(resp, "href");
    const data = first(resp, "calendar-data");
    if (!href || !data) continue;
    out.push({
      href: new URL(href, calendarUrl).href,
      etag: unescapeXml(first(resp, "getetag") ?? ""),
      ics: unescapeXml(data),
    });
  }
  return out;
}

export async function getObject(env: ICloudEnv, href: string): Promise<RemoteObject | null> {
  const res = await dav(env, "GET", href);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`iCloud GET ${res.status}`);
  return { href, etag: res.headers.get("ETag") ?? "", ics: await res.text() };
}

/**
 * Create (ifMatch undefined → If-None-Match: *) or update (If-Match: etag).
 * Returns the new ETag. Throws on 412 (changed on iPhone meanwhile).
 */
export async function putObject(
  env: ICloudEnv,
  href: string,
  ics: string,
  ifMatch?: string,
): Promise<string> {
  const res = await dav(env, "PUT", href, {
    body: ics,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      ...(ifMatch ? { "If-Match": ifMatch } : { "If-None-Match": "*" }),
    },
  });
  if (res.status === 412) throw new Error("iCloud: event changed meanwhile (412)");
  if (!res.ok) throw new Error(`iCloud PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.headers.get("ETag") ?? "";
}

export async function deleteObject(env: ICloudEnv, href: string, ifMatch?: string): Promise<void> {
  const res = await dav(env, "DELETE", href, { headers: ifMatch ? { "If-Match": ifMatch } : {} });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`iCloud DELETE ${res.status}`);
}

/** MKCALENDAR for a new category. */
export async function createCalendar(env: ICloudEnv, home: string, name: string, color: string): Promise<string> {
  const url = new URL(`${crypto.randomUUID().toUpperCase()}/`, home).href;
  const res = await dav(env, "MKCALENDAR", url, {
    body: `<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop>
  <d:displayname>${name.replace(/[<&>]/g, "")}</d:displayname>
  <a:calendar-color>${color}FF</a:calendar-color>
  <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
</d:prop></d:set></c:mkcalendar>`,
  });
  if (!res.ok) throw new Error(`iCloud MKCALENDAR ${res.status}`);
  return url;
}
