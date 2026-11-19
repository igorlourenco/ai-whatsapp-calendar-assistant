import { describe, expect, it } from "vitest";

import { icloudAccount } from "./context";
import type { Profile } from "./db/schema";
import { open, seal } from "./secrets";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("credential encryption", () => {
  it("round-trips, random IV, no plaintext in the sealed value", async () => {
    const a = await seal(KEY, "senha-secreta");
    const b = await seal(KEY, "senha-secreta");
    expect(a).not.toBe(b);
    expect(a).not.toContain("senha");
    expect(await open(KEY, a)).toBe("senha-secreta");
  });

  it("wrong key or tampered value fails; bad key size is explicit", async () => {
    const s = await seal(KEY, "x");
    await expect(open(OTHER, s)).rejects.toThrow();
    await expect(open(KEY, s.slice(0, -4) + "AAAA")).rejects.toThrow();
    await expect(seal("short", "x")).rejects.toThrow(/CREDENTIALS_KEY/);
    await expect(seal(undefined, "x")).rejects.toThrow(/CREDENTIALS_KEY/);
  });
});

describe("whose iCloud", () => {
  const env = { ICLOUD_USERNAME: "owner@x.com", ICLOUD_APP_PASSWORD: "owner-pass", CREDENTIALS_KEY: KEY } as unknown as Env;
  const base = { id: 1, phone: "556300000000", name: "Ana", storage: "icloud", tz: null, morningAt: null, eveningAt: null, defaultReminder: null, feedUrl: null, createdAt: new Date() };

  it("owner (no profile, or one without a phone) → deployment's iCloud", async () => {
    expect(await icloudAccount(env, null)).toBe(env);
    expect(await icloudAccount(env, { ...base, phone: null, icloudCredentials: null } as Profile)).toBe(env);
  });

  it("a user's object without credentials never falls back to the owner's iCloud", async () => {
    await expect(icloudAccount(env, { ...base, icloudCredentials: null } as Profile)).rejects.toThrow(/without iCloud credentials/);
  });

  it("user with credentials → their own iCloud", async () => {
    const icloudCredentials = await seal(KEY, JSON.stringify({ username: "ana@x.com", password: "ana-pass" }));
    expect(await icloudAccount(env, { ...base, icloudCredentials } as Profile)).toEqual({
      ICLOUD_USERNAME: "ana@x.com",
      ICLOUD_APP_PASSWORD: "ana-pass",
    });
  });
});
