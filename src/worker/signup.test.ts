import { describe, expect, it } from "vitest";

import { signupCodes } from "./db/schema";
import {
  CODE_TTL_MS,
  GLOBAL_SENDS_PER_DAY,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_DAY,
  RESEND_AFTER_MS,
  cancelCode,
  parsePhone,
  requestCode,
  verifyCode,
} from "./signup";
import { memoryDb } from "./testing/sqlite";

const T0 = new Date("2026-11-19T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const PHONE = "5563991047668";

async function codeFor(db: Awaited<ReturnType<typeof memoryDb>>, phone = PHONE, now = T0) {
  const r = await requestCode(db, phone, now);
  if (!r.ok) throw new Error(`no code: ${r.reason}`);
  return r.code;
}

describe("parsePhone", () => {
  it("Brazilian numbers without +55 get it; + numbers are taken as is", () => {
    expect(parsePhone("(63) 99104-7668")).toBe("5563991047668");
    expect(parsePhone("63 9104-7668")).toBe("556391047668");
    expect(parsePhone("+55 63 99104-7668")).toBe("5563991047668");
    expect(parsePhone("+1 415 555 0100")).toBe("14155550100");
    expect(parsePhone("00351 912 345 678")).toBe("351912345678");
  });

  it("rejects what can't be a number", () => {
    expect(parsePhone("")).toBeNull();
    expect(parsePhone("12345")).toBeNull();
    expect(parsePhone("+55 63 9104")).toBeNull();
    expect(parsePhone("+1234567890123456")).toBeNull();
  });
});

describe("signup codes", () => {
  it("right code works once; with or without the BR 9th digit", async () => {
    const db = await memoryDb();
    const code = await codeFor(db);
    expect(code).toMatch(/^\d{6}$/);
    expect(await verifyCode(db, "556391047668", code, at(1000))).toBe("ok");
    expect(await verifyCode(db, PHONE, code, at(2000))).toBe("expired");
  });

  it("code expires", async () => {
    const db = await memoryDb();
    const code = await codeFor(db);
    expect(await verifyCode(db, PHONE, code, at(CODE_TTL_MS + 1))).toBe("expired");
  });

  it("wrong guesses lock the code, even for the right one afterwards", async () => {
    const db = await memoryDb();
    const code = await codeFor(db);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(await verifyCode(db, PHONE, wrong, at(i))).toBe("wrong");
    expect(await verifyCode(db, PHONE, wrong, at(MAX_ATTEMPTS))).toBe("locked");
    expect(await verifyCode(db, PHONE, code, at(MAX_ATTEMPTS + 1))).toBe("locked");
  });

  it("a new code replaces the old one and resets attempts", async () => {
    const db = await memoryDb();
    const first = await codeFor(db);
    const second = await codeFor(db, PHONE, at(RESEND_AFTER_MS));
    if (first !== second) expect(await verifyCode(db, PHONE, first, at(RESEND_AFTER_MS + 1))).toBe("wrong");
    expect(await verifyCode(db, PHONE, second, at(RESEND_AFTER_MS + 2))).toBe("ok");
  });

  it("no code for a number that never asked", async () => {
    const db = await memoryDb();
    expect(await verifyCode(db, PHONE, "123456", T0)).toBe("expired");
  });

  it("resend waits a minute; at most MAX_SENDS_PER_DAY per number per 24 h", async () => {
    const db = await memoryDb();
    await codeFor(db);
    expect(await requestCode(db, PHONE, at(10_000))).toEqual({ ok: false, reason: "wait", seconds: 50 });
    for (let i = 1; i < MAX_SENDS_PER_DAY; i++) await codeFor(db, PHONE, at(i * RESEND_AFTER_MS));
    expect(await requestCode(db, PHONE, at(MAX_SENDS_PER_DAY * RESEND_AFTER_MS))).toEqual({ ok: false, reason: "limit" });
    expect((await requestCode(db, PHONE, at(24 * 60 * 60_000 + 1))).ok).toBe(true);
  });

  it("cancelCode: a failed send doesn't count and can be retried right away", async () => {
    const db = await memoryDb();
    const code = await codeFor(db);
    await cancelCode(db, PHONE);
    expect(await verifyCode(db, PHONE, code, at(1))).toBe("expired");
    const [row] = await db.select().from(signupCodes);
    expect(row?.sends).toBe(0);
    expect((await requestCode(db, PHONE, at(2))).ok).toBe(true);
  });

  it("global daily cap across all numbers", async () => {
    const db = await memoryDb();
    await db.insert(signupCodes).values({
      phone: "14155550100",
      codeHash: null,
      expiresAt: T0,
      sends: GLOBAL_SENDS_PER_DAY,
      windowStart: at(-60_000),
      lastSentAt: at(-60_000),
    });
    expect(await requestCode(db, PHONE, T0)).toEqual({ ok: false, reason: "busy" });
    expect((await requestCode(db, PHONE, at(24 * 60 * 60_000))).ok).toBe(true);
  });
});
