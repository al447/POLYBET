import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COPY_STORAGE_KEYS,
  LEDGER_MAX_ENTRIES,
  appendLedger,
  clearCopyStorage,
  readFollows,
  readLedger,
  sanitiseFollows,
  sanitiseLedger,
  sanitiseSettings,
  updateLedgerEntry,
  writeFollows,
} from "./store";
import { DEFAULT_COPY_SETTINGS, type CopyLedgerEntry, type FollowedTrader } from "./types";

const WTSA = "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8";

/**
 * Minimal in-memory stand-in for `localStorage` — the tests run under vitest's
 * node environment, which has none.
 *
 * Deliberately not declared `implements Storage`: that interface carries an
 * index signature (`[name: string]: any`), which a class cannot satisfy.
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

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: store });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function follow(overrides: Partial<FollowedTrader> = {}): FollowedTrader {
  return {
    address: WTSA,
    name: "WTSA",
    followedAt: "2026-08-17T12:00:00.000Z",
    cursor: 1786932886,
    paused: false,
    settings: DEFAULT_COPY_SETTINGS,
    ...overrides,
  };
}

function entry(overrides: Partial<CopyLedgerEntry> = {}): CopyLedgerEntry {
  return {
    id: "e1",
    intentKey: `${WTSA}:token:BUY:1786932886`,
    address: WTSA,
    traderName: "WTSA",
    side: "BUY",
    tokenId: "token",
    conditionId: "0xf43f26",
    title: "Will Club Tijuana win on 2026-08-16?",
    outcome: "Yes",
    slug: "mex-tij-caz-2026-08-16-tij",
    eventSlug: "mex-tij-caz-2026-08-16",
    decidedAt: "2026-08-17T12:00:00.000Z",
    sourceTimestamp: 1786932886,
    status: "simulated",
    amountUsd: 25,
    ...overrides,
  };
}

describe("sanitiseFollows", () => {
  /**
   * 🚩 The single most important assertion in this file. A cursor of `0` means
   * "copy every trade this person has ever made" — for a real account that is
   * hundreds of orders, placed at once. Corrupt input must fail toward copying
   * nothing.
   */
  it("normalises an unusable cursor to null, never to zero", () => {
    for (const cursor of [undefined, null, "1786932886", Number.NaN, -1, Infinity]) {
      const [parsed] = sanitiseFollows([{ ...follow(), cursor }]);
      expect(parsed.cursor).toBeNull();
    }
  });

  it("keeps a valid cursor", () => {
    const [parsed] = sanitiseFollows([follow()]);
    expect(parsed.cursor).toBe(1786932886);
  });

  it("drops duplicate addresses, which would otherwise double every copy", () => {
    const parsed = sanitiseFollows([follow(), follow({ name: "again" })]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("WTSA");
  });

  it("lowercases addresses so they match the trade feed", () => {
    const [parsed] = sanitiseFollows([follow({ address: WTSA.toUpperCase().replace("0X", "0x") })]);
    expect(parsed.address).toBe(WTSA);
  });

  it("drops rows without a plausible address", () => {
    expect(sanitiseFollows([follow({ address: "" }), follow({ address: "not-an-address" })])).toEqual(
      [],
    );
  });

  it("falls back to the address when the stored name is unusable", () => {
    const [parsed] = sanitiseFollows([{ ...follow(), name: 42 }]);
    expect(parsed.name).toBe(WTSA);
  });

  it("discards an unparseable followedAt rather than keeping a bad date", () => {
    const [parsed] = sanitiseFollows([{ ...follow(), followedAt: "yesterday" }]);
    expect(parsed.followedAt).toBe("");
  });

  it("survives a non-array payload", () => {
    expect(sanitiseFollows(null)).toEqual([]);
    expect(sanitiseFollows({ follows: [] })).toEqual([]);
    expect(sanitiseFollows(["x", 1, null])).toEqual([]);
  });
});

describe("sanitiseSettings", () => {
  /**
   * Every unreadable limit lands on the conservative default. The failure to
   * avoid is a missing cap read as "no cap".
   */
  it("falls back to the defaults rather than to unlimited", () => {
    expect(sanitiseSettings(undefined)).toEqual(DEFAULT_COPY_SETTINGS);
    expect(sanitiseSettings({ dailyCapUsd: Infinity }).dailyCapUsd).toBe(
      DEFAULT_COPY_SETTINGS.dailyCapUsd,
    );
    expect(sanitiseSettings({ perTradeCapUsd: -10 }).perTradeCapUsd).toBe(
      DEFAULT_COPY_SETTINGS.perTradeCapUsd,
    );
    expect(sanitiseSettings({ totalCapUsd: "500" }).totalCapUsd).toBe(
      DEFAULT_COPY_SETTINGS.totalCapUsd,
    );
  });

  it("keeps valid caps", () => {
    const settings = sanitiseSettings({ perTradeCapUsd: 5, dailyCapUsd: 20, totalCapUsd: 60 });
    expect(settings.perTradeCapUsd).toBe(5);
    expect(settings.dailyCapUsd).toBe(20);
    expect(settings.totalCapUsd).toBe(60);
  });

  it("round-trips both sizing modes and rejects an unknown one", () => {
    expect(sanitiseSettings({ sizing: { mode: "percent", percentOfTheirNotional: 0.5 } }).sizing).toEqual(
      { mode: "percent", percentOfTheirNotional: 0.5 },
    );
    expect(sanitiseSettings({ sizing: { mode: "fixed", usd: 10 } }).sizing).toEqual({
      mode: "fixed",
      usd: 10,
    });
    expect(sanitiseSettings({ sizing: { mode: "martingale" } }).sizing).toEqual(
      DEFAULT_COPY_SETTINGS.sizing,
    );
  });
});

describe("sanitiseLedger", () => {
  it("drops rows that cannot serve as a dedup key", () => {
    // Without an intent key, a reload could re-place a copy already made.
    expect(sanitiseLedger([{ ...entry(), id: "" }])).toEqual([]);
    expect(sanitiseLedger([{ ...entry(), intentKey: "" }])).toEqual([]);
  });

  it("drops rows with an unrecognised status or side", () => {
    expect(sanitiseLedger([{ ...entry(), status: "pending" }])).toEqual([]);
    expect(sanitiseLedger([{ ...entry(), side: "MERGE" }])).toEqual([]);
  });

  it("keeps a skip reason only when it is one we know", () => {
    expect(sanitiseLedger([entry({ status: "skipped", skipReason: "daily_cap" })])[0].skipReason).toBe(
      "daily_cap",
    );
    expect(
      sanitiseLedger([{ ...entry(), status: "skipped", skipReason: "vibes" }])[0].skipReason,
    ).toBeUndefined();
  });

  it("leaves absent money fields undefined rather than zero", () => {
    // `0` and "not recorded" mean different things to the headline tiles.
    const [parsed] = sanitiseLedger([{ ...entry(), amountUsd: undefined, feeBps: "50" }]);
    expect(parsed.amountUsd).toBeUndefined();
    expect(parsed.feeBps).toBeUndefined();
  });

  it("survives a non-array payload", () => {
    expect(sanitiseLedger(null)).toEqual([]);
    expect(sanitiseLedger("[]")).toEqual([]);
  });
});

describe("storage round-trip", () => {
  it("persists and reloads follows", () => {
    writeFollows([follow()]);
    expect(readFollows()).toEqual([follow()]);
  });

  it("reads corrupt JSON as empty instead of throwing", () => {
    store.setItem(COPY_STORAGE_KEYS.follows, "{not json");
    expect(readFollows()).toEqual([]);

    store.setItem(COPY_STORAGE_KEYS.ledger, "{not json");
    expect(readLedger()).toEqual([]);
  });

  it("returns empty during SSR, where there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(readFollows()).toEqual([]);
    expect(readLedger()).toEqual([]);
    expect(writeFollows([follow()])).toBe(false);
  });

  it("prepends new ledger rows so the newest read first", () => {
    const first = appendLedger([], [entry({ id: "old" })]);
    const second = appendLedger(first, [entry({ id: "new" })]);

    expect(second.map((e) => e.id)).toEqual(["new", "old"]);
    expect(readLedger().map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("returns the list unchanged when there is nothing to add", () => {
    const existing = [entry()];
    expect(appendLedger(existing, [])).toBe(existing);
  });

  it("caps the ledger at LEDGER_MAX_ENTRIES", () => {
    const many = Array.from({ length: LEDGER_MAX_ENTRIES + 10 }, (_, i) => entry({ id: `e${i}` }));
    const next = appendLedger([], many);

    expect(next).toHaveLength(LEDGER_MAX_ENTRIES);
    expect(next[0].id).toBe("e0");
  });

  it("patches one row by id — how a queued copy becomes placed", () => {
    const initial = appendLedger([], [entry({ id: "a", status: "queued" })]);
    const next = updateLedgerEntry(initial, "a", { status: "placed", feeBps: 50 });

    expect(next[0].status).toBe("placed");
    expect(next[0].feeBps).toBe(50);
    expect(readLedger()[0].status).toBe("placed");
  });

  it("sheds the oldest half rather than losing the write entirely on a quota error", () => {
    let rejectOnce = true;
    vi.stubGlobal("window", {
      localStorage: {
        ...store,
        getItem: (k: string) => store.getItem(k),
        removeItem: (k: string) => store.removeItem(k),
        setItem: (k: string, v: string) => {
          if (rejectOnce) {
            rejectOnce = false;
            throw new DOMException("quota", "QuotaExceededError");
          }
          store.setItem(k, v);
        },
      },
    });

    const rows = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" }), entry({ id: "d" })];
    appendLedger([], rows);

    // Newest kept, oldest shed — history is what gets discarded, not state.
    expect(readLedger().map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("clears both keys", () => {
    writeFollows([follow()]);
    appendLedger([], [entry()]);
    clearCopyStorage();

    expect(readFollows()).toEqual([]);
    expect(readLedger()).toEqual([]);
  });
});
