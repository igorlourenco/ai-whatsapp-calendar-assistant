import { describe, expect, it } from "vitest";

import { SESSION_TTL_MS, createSession, readSession } from "./session";

const KEY = "k".repeat(44);
const T0 = Date.UTC(2026, 10, 19, 12);

describe("signup session", () => {
  it("round-trips the phone until it expires", async () => {
    const t = await createSession(KEY, "5563991047668", T0);
    expect(await readSession(KEY, t, T0 + 1000)).toBe("5563991047668");
    expect(await readSession(KEY, t, T0 + SESSION_TTL_MS)).toBeNull();
  });

  it("rejects tampering, another key and junk", async () => {
    const t = await createSession(KEY, "5563991047668", T0);
    const [, exp, sig] = t.split(".");
    expect(await readSession(KEY, `5511999999999.${exp}.${sig}`, T0)).toBeNull();
    expect(await readSession(KEY, `5563991047668.${Number(exp) + 1}.${sig}`, T0)).toBeNull();
    expect(await readSession("x".repeat(44), t, T0)).toBeNull();
    expect(await readSession(KEY, "", T0)).toBeNull();
    expect(await readSession(KEY, undefined, T0)).toBeNull();
  });

  it("needs a key", async () => {
    await expect(createSession(undefined, "5563991047668", T0)).rejects.toThrow();
  });
});
