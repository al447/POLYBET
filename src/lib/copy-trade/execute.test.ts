import { describe, expect, it } from "vitest";

import {
  checkCopyPreconditions,
  hasExpired,
  placeableGuard,
  planResolution,
  priceGuard,
  quantiseToTick,
  requiredUsd,
} from "./execute";
import { QUEUE_EXPIRY_MS, type CopyLedgerEntry } from "./types";

/**
 * The pure decisions: what stops a copy (`checkCopyPreconditions`, shared by
 * the dry run and the live click) and what price band it carries (`priceGuard`).
 *
 * `placeCopy` itself is not tested here — it is sequencing around these two
 * plus `placeMarketBuy`, and a test of it would be a test of mocks. Everything
 * in it that *decides* anything lives in the two functions below.
 */

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function buyEntry(overrides: Partial<CopyLedgerEntry> = {}): CopyLedgerEntry {
  return {
    id: "row-1",
    intentKey: "0xabc:12345:BUY:1786932886",
    address: "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8",
    traderName: "Whale",
    side: "BUY",
    tokenId: "64921565195123",
    conditionId: "0xf43f26",
    title: "Will Club Tijuana win on 2026-08-16?",
    outcome: "Yes",
    slug: "mex-tij-caz-2026-08-16-tij",
    eventSlug: "mex-tij-caz-2026-08-16",
    decidedAt: new Date(NOW - 1000).toISOString(),
    sourceTimestamp: 1786932886,
    status: "queued",
    amountUsd: 10,
    expectedPrice: 0.32,
    ...overrides,
  };
}

const ALLOWED = { allowed: true, feeBps: { taker: 50, maker: 0 } } as const;

describe("requiredUsd", () => {
  it("adds the taker fee on top of the notional", () => {
    // 50 bps = 0.50%, so a $10 copy needs $10.05.
    expect(requiredUsd(10, 50)).toBeCloseTo(10.05, 10);
  });

  it("treats a missing or nonsense fee as zero rather than NaN", () => {
    expect(requiredUsd(10, Number.NaN)).toBe(10);
    expect(requiredUsd(10, -5)).toBe(10);
  });
});

describe("hasExpired", () => {
  it("is false inside the window and true past it", () => {
    const fresh = buyEntry({ decidedAt: new Date(NOW - QUEUE_EXPIRY_MS + 1000).toISOString() });
    const stale = buyEntry({ decidedAt: new Date(NOW - QUEUE_EXPIRY_MS - 1000).toISOString() });

    expect(hasExpired(fresh, NOW)).toBe(false);
    expect(hasExpired(stale, NOW)).toBe(true);
  });

  it("does not expire a row whose timestamp is unreadable", () => {
    // Storage is user-writable. A corrupt date must not silently cancel a copy;
    // the sanitiser already drops unparseable timestamps to "".
    expect(hasExpired(buyEntry({ decidedAt: "" }), NOW)).toBe(false);
  });
});

describe("planResolution", () => {
  it("records a simulated copy with the disclosed fee", () => {
    const patch = planResolution({
      entry: buyEntry(),
      preflight: ALLOWED,
      availableUsd: 100,
      nowMs: NOW,
    });

    expect(patch).toEqual({ status: "simulated", feeBps: 50 });
  });

  it("cancels an expired row before the preflight is even consulted", () => {
    const patch = planResolution({
      entry: buyEntry({ decidedAt: new Date(NOW - QUEUE_EXPIRY_MS - 1).toISOString() }),
      preflight: ALLOWED,
      availableUsd: 100,
      nowMs: NOW,
    });

    expect(patch.status).toBe("cancelled");
    expect(patch.skipReason).toBeUndefined();
  });

  it("skips with the server's own message when the preflight rejects", () => {
    const patch = planResolution({
      entry: buyEntry(),
      preflight: {
        allowed: false,
        reason: "terms_not_accepted",
        message: "Please accept the Terms of Service and Risk Disclosure before trading.",
      },
      availableUsd: 100,
      nowMs: NOW,
    });

    expect(patch.status).toBe("skipped");
    expect(patch.skipReason).toBe("preflight_rejected");
    expect(patch.error).toContain("Terms of Service");
  });

  it("fails, rather than skipping, when the preflight could not be reached", () => {
    // A network blip is not a decision about the copy, and must not be filed
    // under the caps working correctly.
    const patch = planResolution({
      entry: buyEntry(),
      preflight: null,
      availableUsd: 100,
      nowMs: NOW,
    });

    expect(patch.status).toBe("failed");
  });

  it("counts the fee in the balance check, not just the notional", () => {
    // $10.02 covers the $10 notional but not the $10.05 it really costs.
    const patch = planResolution({
      entry: buyEntry(),
      preflight: ALLOWED,
      availableUsd: 10.02,
      nowMs: NOW,
    });

    expect(patch.status).toBe("skipped");
    expect(patch.skipReason).toBe("insufficient_balance");
    // Still recorded, so the Skipped row can show what it would have cost.
    expect(patch.feeBps).toBe(50);
  });

  it("passes when the balance covers notional plus fee exactly", () => {
    const patch = planResolution({
      entry: buyEntry(),
      preflight: ALLOWED,
      availableUsd: 10.05,
      nowMs: NOW,
    });

    expect(patch.status).toBe("simulated");
  });

  it("does not block on an unreadable balance", () => {
    // The wallet may simply not be connected yet.
    const patch = planResolution({
      entry: buyEntry(),
      preflight: ALLOWED,
      availableUsd: null,
      nowMs: NOW,
    });

    expect(patch.status).toBe("simulated");
  });

  it("never consults the balance for a sell", () => {
    // Selling returns money; its fee comes out of the proceeds.
    const patch = planResolution({
      entry: buyEntry({ side: "SELL", amountUsd: undefined, shares: 60 }),
      preflight: ALLOWED,
      availableUsd: 0,
      nowMs: NOW,
    });

    expect(patch.status).toBe("simulated");
  });

  it("fails a buy with no readable size rather than treating it as free", () => {
    // Reachable from hand-edited storage: `sanitiseLedger` keeps `amountUsd`
    // optional. Reading it as 0 would clear the balance check and file a $0
    // position that the headline tiles then sum.
    const patch = planResolution({
      entry: buyEntry({ amountUsd: undefined }),
      preflight: ALLOWED,
      availableUsd: 0,
      nowMs: NOW,
    });

    expect(patch.status).toBe("failed");
  });
});

describe("checkCopyPreconditions — the live-only branches", () => {
  it("skips a settled market before it spends the preflight's answer", () => {
    // Event legs settle individually, long before the event closes. Copying
    // into one is not a rejection to explain away — it is a market that no
    // longer exists.
    const check = checkCopyPreconditions({
      entry: buyEntry(),
      preflight: ALLOWED,
      availableUsd: 100,
      marketOpen: false,
      nowMs: NOW,
    });

    expect(check.blocked).toBe(true);
    expect(check.blocked && check.patch.skipReason).toBe("market_closed");
  });

  it("does not block when the market state could not be read", () => {
    // A lookup blip is not evidence of a settled market, and the CLOB rejects
    // the order upstream if we are wrong.
    for (const marketOpen of [null, undefined, true] as const) {
      const check = checkCopyPreconditions({
        entry: buyEntry(),
        preflight: ALLOWED,
        availableUsd: 100,
        marketOpen,
        nowMs: NOW,
      });
      expect(check.blocked).toBe(false);
    }
  });

  it("expires before it consults the market, so a stale row costs no requests", () => {
    const check = checkCopyPreconditions({
      entry: buyEntry({ decidedAt: new Date(NOW - QUEUE_EXPIRY_MS - 1).toISOString() }),
      preflight: ALLOWED,
      availableUsd: 100,
      marketOpen: false,
      nowMs: NOW,
    });

    expect(check.blocked && check.patch.status).toBe("cancelled");
  });

  it("fails a sell with no readable share count", () => {
    // `placeMarketSell` takes shares. A row without them has nothing to send,
    // and `String(undefined)` would post the literal "undefined".
    const check = checkCopyPreconditions({
      entry: buyEntry({ side: "SELL", amountUsd: undefined, shares: undefined }),
      preflight: ALLOWED,
      availableUsd: 100,
      nowMs: NOW,
    });

    expect(check.blocked && check.patch.status).toBe("failed");
  });

  it("hands the disclosed fee back when nothing blocks", () => {
    const check = checkCopyPreconditions({
      entry: buyEntry(),
      preflight: ALLOWED,
      availableUsd: 100,
      marketOpen: true,
      nowMs: NOW,
    });

    expect(check).toEqual({ blocked: false, feeBps: 50 });
  });
});

describe("priceGuard", () => {
  it("caps a buy 5% above the price they filled at", () => {
    // They bought at 0.32; we will not pay more than 0.336 to follow them.
    expect(priceGuard(buyEntry())).toEqual({ maxPrice: "0.336" });
  });

  it("floors a sell 5% below the price they filled at", () => {
    expect(priceGuard(buyEntry({ side: "SELL", expectedPrice: 0.32 }))).toEqual({
      minPrice: "0.304",
    });
  });

  it("is the intended band only, and may sit outside the tradeable range", () => {
    // 0.98 + 5% is 1.029, which is not a price that exists. Clamping is
    // `quantiseToTick`'s job now, because the real bounds are `[tick, 1 - tick]`
    // and this function does not know the tick.
    expect(priceGuard(buyEntry({ expectedPrice: 0.98 }))).toEqual({ maxPrice: "1.029" });
  });

  it("sends no guard at all when the anchor price is unusable", () => {
    // A garbage anchor would set the bound somewhere arbitrary and every copy
    // of that market would silently fail to fill. Unguarded is the lesser evil.
    for (const expectedPrice of [undefined, 0, 1, Number.NaN]) {
      expect(priceGuard(buyEntry({ expectedPrice }))).toEqual({});
    }
  });
});

describe("quantiseToTick", () => {
  it("snaps a three-decimal bound onto a 0.01 grid", () => {
    // 🚩 The measured regression: nine markets in ten have a 0.01 tick, and the
    // SDK rejects `"0.336"` there with "must conform to tick size 0.01 with at
    // most 2 decimal places" — before the order is ever signed.
    expect(quantiseToTick(0.336, 0.01, "up")).toBe("0.34");
  });

  it("does not leak binary floating point into the price", () => {
    // `34 * 0.01` is 0.34000000000000002, which fails the SDK's decimal check
    // far more spectacularly than the three-decimal bug it replaced.
    const result = quantiseToTick(0.336, 0.01, "up");
    expect(result).toBe("0.34");
    expect(Number(result)).toBe(0.34);
  });

  it("rounds a buy up and a sell down, so the copy stays placeable", () => {
    expect(quantiseToTick(0.336, 0.01, "up")).toBe("0.34");
    expect(quantiseToTick(0.304, 0.01, "down")).toBe("0.30");
  });

  it("keeps three decimals on a market whose tick is 0.001", () => {
    expect(quantiseToTick(0.336, 0.001, "up")).toBe("0.336");
  });

  it("clamps to [tick, 1 - tick], not to [0.001, 0.999]", () => {
    // The old clamp produced 0.999 on a 0.01 market, which the SDK rejects on
    // its range check rather than its decimals check — same dead end.
    expect(quantiseToTick(1.029, 0.01, "up")).toBe("0.99");
    expect(quantiseToTick(0.0004, 0.01, "down")).toBe("0.01");
  });

  it("leaves a price already on the grid where it is", () => {
    // Binary floating point makes this the trap it is: `0.34 / 0.01` is
    // 34.000000000000004 and `0.29 / 0.01` is 28.999999999999996, so a naive
    // ceil/floor moves both by a full tick in the wrong direction.
    expect(quantiseToTick(0.34, 0.01, "up")).toBe("0.34");
    expect(quantiseToTick(0.29, 0.01, "down")).toBe("0.29");
    expect(quantiseToTick(0.07, 0.01, "up")).toBe("0.07");
  });

  it("returns null for a tick it cannot use", () => {
    expect(quantiseToTick(0.5, 0, "up")).toBeNull();
    expect(quantiseToTick(0.5, Number.NaN, "up")).toBeNull();
    expect(quantiseToTick(Number.NaN, 0.01, "up")).toBeNull();
  });

  /**
   * The SDK's `nr()` throws on three separate conditions. Asserting them as
   * properties across the whole price range is what makes this a fix rather
   * than six examples that happen to pass.
   */
  it.each([0.01, 0.001])("always satisfies every rule the SDK enforces (tick %s)", (tick) => {
    const decimals = String(tick).split(".")[1].length;

    for (let anchor = 0.001; anchor < 1; anchor += 0.001) {
      for (const direction of ["up", "down"] as const) {
        const raw = anchor * (direction === "up" ? 1.05 : 0.95);
        const value = quantiseToTick(raw, tick, direction);
        expect(value).not.toBeNull();

        const n = Number(value);
        // 1. within [tick, 1 - tick]
        expect(n).toBeGreaterThanOrEqual(tick);
        expect(n).toBeLessThanOrEqual(1 - tick);
        // 2. no more decimal places than the tick has — counted off the number,
        //    which is what the SDK sees after its schema coerces the string.
        const seen = String(n).includes(".") ? String(n).split(".")[1].length : 0;
        expect(seen).toBeLessThanOrEqual(decimals);
        // 3. a whole multiple of the tick
        const scale = 10 ** decimals;
        expect(Math.round(n * scale) % Math.round(tick * scale)).toBe(0);
      }
    }
  });
});

describe("placeableGuard", () => {
  it("snaps the intended band onto the market grid", () => {
    expect(placeableGuard(buyEntry(), 0.01)).toEqual({ maxPrice: "0.34" });
    expect(placeableGuard(buyEntry({ side: "SELL", expectedPrice: 0.32 }), 0.01)).toEqual({
      minPrice: "0.30",
    });
  });

  it("sends no guard when the tick could not be read", () => {
    // An unguarded copy is worse than a guarded one — but an *invalid* guard
    // fails every single time, which is worse than both.
    expect(placeableGuard(buyEntry(), null)).toEqual({});
  });

  it("sends no guard when the anchor was unusable to begin with", () => {
    expect(placeableGuard(buyEntry({ expectedPrice: Number.NaN }), 0.01)).toEqual({});
  });

  it("would have placed every one of the fills that used to be rejected", () => {
    // The exact anchors sampled from live leaderboard traders on 2026-08-19,
    // seven of which the SDK refused under the old three-decimal format.
    for (const anchor of [0.5918, 0.29, 0.5, 0.5513, 0.53, 0.4104, 0.43]) {
      const { maxPrice } = placeableGuard(buyEntry({ expectedPrice: anchor }), 0.01);
      expect(maxPrice).toBeDefined();
      expect(Number(maxPrice)).toBeGreaterThan(anchor);
      expect(String(Number(maxPrice)).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });
});
