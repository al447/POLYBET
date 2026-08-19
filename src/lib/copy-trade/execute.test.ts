import { describe, expect, it } from "vitest";

import { hasExpired, planResolution, requiredUsd } from "./execute";
import { QUEUE_EXPIRY_MS, type CopyLedgerEntry } from "./types";

/**
 * `planResolution` is the only part of the dry run that decides anything, so it
 * is the only part worth testing here — `runPreflight` and `readAvailableUsd`
 * are one-line wrappers over helpers already covered elsewhere.
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
