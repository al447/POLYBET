import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCachedCredentials,
  describeConnectError,
  isTimeoutError,
  readCachedCredentials,
  sanitiseCredentials,
  writeCachedCredentials,
  type ClobCredentials,
} from "./clob-credentials";

const EOA = "0x04d5524a0a5Af2ECa6E39E03DEFC261d42fE66D8";
const KEY = "polymarket:clob-creds:0x04d5524a0a5af2eca6e39e03defc261d42fe66d8";

/**
 * Minimal in-memory stand-in for `sessionStorage` — the tests run under
 * vitest's node environment, which has none. Same shape as the stub in
 * `copy-trade/store.test.ts`, and not declared `implements Storage` for the
 * same reason (that interface's index signature is unsatisfiable by a class).
 */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

let store: MemoryStorage;

const CREDS: ClobCredentials = {
  key: "b1a4f0e2-0c2e-4f21-9a3d-8f0b6c1d2e3f",
  secret: "c2VjcmV0LXZhbHVl",
  passphrase: "a-passphrase",
};

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal("window", { sessionStorage: store });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitiseCredentials", () => {
  it("accepts a complete credential blob", () => {
    expect(sanitiseCredentials(CREDS)).toEqual(CREDS);
  });

  it("drops unknown fields rather than passing them to the SDK", () => {
    expect(sanitiseCredentials({ ...CREDS, apiKey: "legacy", nonce: 7 })).toEqual(CREDS);
  });

  it.each([
    ["missing secret", { key: CREDS.key, passphrase: CREDS.passphrase }],
    ["missing passphrase", { key: CREDS.key, secret: CREDS.secret }],
    ["missing key", { secret: CREDS.secret, passphrase: CREDS.passphrase }],
  ])("rejects a partial blob (%s) rather than half-authenticating", (_label, value) => {
    expect(sanitiseCredentials(value)).toBeNull();
  });

  it("rejects empty strings — a blank passphrase fails L2 signing, not parsing", () => {
    expect(sanitiseCredentials({ ...CREDS, passphrase: "" })).toBeNull();
  });

  it("rejects non-string fields", () => {
    expect(sanitiseCredentials({ ...CREDS, secret: 12345 })).toBeNull();
  });

  it.each([[null], [undefined], ["a string"], [42], [[]]])(
    "rejects a non-object (%s)",
    (value) => {
      expect(sanitiseCredentials(value)).toBeNull();
    },
  );
});

describe("credential cache", () => {
  it("round-trips through storage", () => {
    writeCachedCredentials(EOA, CREDS);
    expect(readCachedCredentials(EOA)).toEqual(CREDS);
  });

  it("keys by lowercased address, so casing from the wallet never splits the cache", () => {
    writeCachedCredentials(EOA, CREDS);
    expect(store.getItem(KEY)).not.toBeNull();
    expect(readCachedCredentials(EOA.toLowerCase())).toEqual(CREDS);
    expect(readCachedCredentials(EOA.toUpperCase())).toEqual(CREDS);
  });

  it("does not leak one signer's credentials to another", () => {
    writeCachedCredentials(EOA, CREDS);
    expect(readCachedCredentials("0x0000000000000000000000000000000000000001")).toBeNull();
  });

  it("returns null for an address that was never cached", () => {
    expect(readCachedCredentials(EOA)).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    store.setItem(KEY, "{not json");
    expect(readCachedCredentials(EOA)).toBeNull();
  });

  it("returns null on a half-written blob — the dangerous stored shape", () => {
    store.setItem(KEY, JSON.stringify({ key: CREDS.key }));
    expect(readCachedCredentials(EOA)).toBeNull();
  });

  it("refuses to persist an invalid blob", () => {
    writeCachedCredentials(EOA, { key: CREDS.key, secret: "", passphrase: "" });
    expect(store.getItem(KEY)).toBeNull();
  });

  it("clears one entry", () => {
    writeCachedCredentials(EOA, CREDS);
    clearCachedCredentials(EOA);
    expect(readCachedCredentials(EOA)).toBeNull();
  });

  it("falls back to null when storage is unavailable, never throwing", () => {
    // Private browsing / storage disabled: `sessionStorage` access itself
    // throws. Login must still be possible — it just costs a signature.
    vi.stubGlobal("window", {
      get sessionStorage(): MemoryStorage {
        throw new Error("The operation is insecure.");
      },
    });

    expect(() => readCachedCredentials(EOA)).not.toThrow();
    expect(readCachedCredentials(EOA)).toBeNull();
    expect(() => writeCachedCredentials(EOA, CREDS)).not.toThrow();
    expect(() => clearCachedCredentials(EOA)).not.toThrow();
  });
});

describe("isTimeoutError", () => {
  it("matches ky's TimeoutError, which is what the CLOB auth failure actually is", () => {
    // Reproduces `node_modules/ky/distribution/errors/TimeoutError.js`.
    const error = new Error(
      "Request timed out: POST https://clob.polymarket.com/auth/api-key",
    );
    error.name = "TimeoutError";
    expect(isTimeoutError(error)).toBe(true);
  });

  it("matches on the message when the SDK re-wraps and loses the name", () => {
    expect(isTimeoutError(new Error("Perps event wait timed out."))).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isTimeoutError(new Error("User rejected the request"))).toBe(false);
    expect(isTimeoutError(new Error("Failed to fetch"))).toBe(false);
  });

  it("does not match non-errors", () => {
    expect(isTimeoutError("timed out")).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe("describeConnectError", () => {
  it("replaces ky's URL-bearing string with something actionable", () => {
    const error = new Error(
      "Request timed out: POST https://clob.polymarket.com/auth/api-key",
    );
    error.name = "TimeoutError";

    const message = describeConnectError(error);
    expect(message).not.toContain("clob.polymarket.com");
    expect(message).toMatch(/try again/i);
  });

  it("passes other error messages through — they are usually the useful ones", () => {
    expect(describeConnectError(new Error("User rejected the request"))).toBe(
      "User rejected the request",
    );
  });

  it("falls back to a stable code for a thrown non-error", () => {
    expect(describeConnectError({ nope: true })).toBe("wallet_setup_failed");
    expect(describeConnectError(new Error(""))).toBe("wallet_setup_failed");
  });
});
