import { describe, expect, it } from "vitest";

import { loginRequests } from "./db/schema";
import { LOGIN_TTL_MS, MAX_LOGINS_PER_HOUR, claimLogin, loginCodeIn, loginText, pollLogin, startLogin } from "./signup";
import { memoryDb } from "./testing/sqlite";

const T0 = new Date("2026-11-19T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const PHONE = "5563991047668";

async function started(db: Awaited<ReturnType<typeof memoryDb>>, now = T0) {
  const s = await startLogin(db, now);
  if (!s.ok) throw new Error("not started");
  return s;
}

describe("loginCodeIn", () => {
  it("finds the code in the filled-in text and in hand-typed variants", () => {
    expect(loginCodeIn(loginText("K7M2QX"))).toBe("K7M2QX");
    expect(loginCodeIn("entrar k7m2qx")).toBe("K7M2QX");
    expect(loginCodeIn("Entrar  K7M2QX ")).toBe("K7M2QX");
  });

  it("ignores ordinary messages and the word 'agenda' alone", () => {
    expect(loginCodeIn("dentista sexta 15h")).toBeNull();
    expect(loginCodeIn("Entrar na agenda")).toBe("AGENDA"); // claimed against the DB → no match, falls through
    expect(loginCodeIn("K7M2QX")).toBeNull();
    expect(loginCodeIn(`entrar ${"x".repeat(100)} K7M2QX`)).toBeNull();
  });
});

describe("WhatsApp-first login", () => {
  it("start → the code arrives from a number → the page gets that number once", async () => {
    const db = await memoryDb();
    const s = await started(db);
    expect(s.code).toMatch(/^[A-HJ-KMNP-Z2-9]{6}$/);
    expect(await pollLogin(db, s.id, at(1000))).toEqual({ status: "pending" });
    expect(await claimLogin(db, s.code.toLowerCase(), "+55 63 99104-7668", at(2000))).toBe(true);
    expect(await pollLogin(db, s.id, at(3000))).toEqual({ status: "ok", phone: PHONE });
    expect(await pollLogin(db, s.id, at(4000))).toEqual({ status: "expired" });
  });

  it("a code is claimed by one number only", async () => {
    const db = await memoryDb();
    const s = await started(db);
    expect(await claimLogin(db, s.code, PHONE, at(1))).toBe(true);
    expect(await claimLogin(db, s.code, "14155550100", at(2))).toBe(false);
    expect(await pollLogin(db, s.id, at(3))).toEqual({ status: "ok", phone: PHONE });
  });

  it("expired codes can't be claimed; unknown ids are expired", async () => {
    const db = await memoryDb();
    const s = await started(db);
    expect(await claimLogin(db, s.code, PHONE, at(LOGIN_TTL_MS + 1))).toBe(false);
    expect(await pollLogin(db, s.id, at(LOGIN_TTL_MS + 1))).toEqual({ status: "expired" });
    expect(await pollLogin(db, "nope", T0)).toEqual({ status: "expired" });
    expect(await pollLogin(db, "a".repeat(48), T0)).toEqual({ status: "expired" });
    expect(await claimLogin(db, "AAAAAA", PHONE, T0)).toBe(false);
  });

  it("caps pending logins per hour", async () => {
    const db = await memoryDb();
    await db.insert(loginRequests).values(
      Array.from({ length: MAX_LOGINS_PER_HOUR }, (_, i) => ({
        id: i.toString(16).padStart(48, "0"),
        code: `C${i}`,
        expiresAt: at(LOGIN_TTL_MS),
        createdAt: at(-60_000),
      })),
    );
    expect((await startLogin(db, T0)).ok).toBe(false);
    expect((await startLogin(db, at(60 * 60_000))).ok).toBe(true);
  });
});
