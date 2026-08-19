import { describe, expect, it } from "vitest";

import {
  decideCopy,
  deployedUsdFor,
  groupFillsIntoIntents,
  selectCopyableIntents,
  summariseBudget,
  utcDayStartMs,
} from "./engine";
import { DEFAULT_COPY_SETTINGS, type CopyLedgerEntry, type TraderTrade } from "./types";

/**
 * Fixtures are the real wire shape from
 * `data-api.polymarket.com/v1/trades?user=0x04d5…66d8` on 2026-08-17 — the same
 * WTSA row quoted in `trader-feed.ts`. Sizes and prices are verbatim so the
 * arithmetic assertions below are checks against real numbers rather than
 * against numbers chosen to make them pass.
 */
const WTSA = "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8";
const TIJUANA_YES = "64921565804805286134965518961016995720099848599334924149956356624078303095123";

function trade(overrides: Partial<TraderTrade> = {}): TraderTrade {
  return {
    address: WTSA,
    side: "BUY",
    tokenId: TIJUANA_YES,
    conditionId: "0xf43f26d689db1915c955fcc219666c011d4d8a640ddab0849f360a6a1928dd0d",
    size: 38132.38,
    price: 0.3234694976,
    timestamp: 1786932886,
    title: "Will Club Tijuana win on 2026-08-16?",
    outcome: "Yes",
    slug: "mex-tij-caz-2026-08-16-tij",
    eventSlug: "mex-tij-caz-2026-08-16",
    transactionHash: "0xcf987ecce63294d79db9136ff3ea2e23229b47ef354378f2a14e34ccbab659d9",
    ...overrides,
  };
}

describe("groupFillsIntoIntents", () => {
  it("collapses several fills of one order into a single intent", () => {
    // The measured case: distinct transaction hashes, identical
    // (asset, side, timestamp). Keying on the hash would yield three copies.
    const intents = groupFillsIntoIntents([
      trade({ size: 10000, price: 0.32, transactionHash: "0xaaa" }),
      trade({ size: 20000, price: 0.33, transactionHash: "0xbbb" }),
      trade({ size: 8132.38, price: 0.34, transactionHash: "0xccc" }),
    ]);

    expect(intents).toHaveLength(1);
    expect(intents[0].fillCount).toBe(3);
    expect(intents[0].shares).toBeCloseTo(38132.38, 2);
    expect(intents[0].notionalUsd).toBeCloseTo(10000 * 0.32 + 20000 * 0.33 + 8132.38 * 0.34, 2);
  });

  it("size-weights the average price rather than taking a plain mean", () => {
    const [intent] = groupFillsIntoIntents([
      trade({ size: 10000, price: 0.31, transactionHash: "0xaaa" }),
      trade({ size: 10, price: 0.8, transactionHash: "0xbbb" }),
    ]);

    // Plain mean would be 0.555 — wrong by a factor that would blow the
    // slippage guard on the copy.
    expect(intent.avgPrice).toBeCloseTo(0.3105, 3);
  });

  it("computes notional from the real WTSA fill", () => {
    const [intent] = groupFillsIntoIntents([trade()]);
    expect(intent.notionalUsd).toBeCloseTo(12334.66, 1);
    expect(intent.fillCount).toBe(1);
  });

  it("keys on address, token, side and time — not on the transaction hash", () => {
    const intents = groupFillsIntoIntents([
      trade({ side: "BUY", transactionHash: "0xaaa" }),
      trade({ side: "SELL", transactionHash: "0xbbb" }),
      trade({ tokenId: "999", transactionHash: "0xccc" }),
    ]);
    expect(intents).toHaveLength(3);
  });

  it("splits fills that are further apart than the grouping window", () => {
    const intents = groupFillsIntoIntents(
      [
        trade({ timestamp: 1000, transactionHash: "0xaaa" }),
        trade({ timestamp: 1001, transactionHash: "0xbbb" }),
        trade({ timestamp: 1010, transactionHash: "0xccc" }),
      ],
      2,
    );

    expect(intents).toHaveLength(2);
    expect(intents[0].fillCount).toBe(2);
    expect(intents[1].fillCount).toBe(1);
  });

  it("drops REDEEM-shaped rows and settlement prices", () => {
    const intents = groupFillsIntoIntents([
      // The exact shape /activity returns for a redemption.
      trade({ side: "" as unknown as "BUY", price: 0, transactionHash: "0xaaa" }),
      trade({ price: 1, transactionHash: "0xbbb" }),
      trade({ price: 0, transactionHash: "0xccc" }),
      trade({ size: 0, transactionHash: "0xddd" }),
    ]);
    expect(intents).toEqual([]);
  });

  it("returns intents oldest first", () => {
    const intents = groupFillsIntoIntents([
      trade({ timestamp: 3000, transactionHash: "0xaaa" }),
      trade({ timestamp: 1000, transactionHash: "0xbbb" }),
      trade({ timestamp: 2000, transactionHash: "0xccc" }),
    ]);
    expect(intents.map((i) => i.timestamp)).toEqual([1000, 2000, 3000]);
  });
});

describe("selectCopyableIntents", () => {
  const trades = [
    trade({ timestamp: 1000, transactionHash: "0xaaa" }),
    trade({ timestamp: 2000, transactionHash: "0xbbb" }),
    trade({ timestamp: 3000, transactionHash: "0xccc" }),
  ];

  it("ignores everything at or before the cursor", () => {
    const { intents } = selectCopyableIntents({ trades, cursor: 2000, nowSeconds: 4000 });
    expect(intents.map((i) => i.timestamp)).toEqual([3000]);
  });

  it("copies nothing at all when the cursor is seeded to now", () => {
    // The follow-time guarantee: following a trader must not replay their
    // history, which for a real account is hundreds of trades.
    const { intents, nextCursor } = selectCopyableIntents({
      trades,
      cursor: 3000,
      nowSeconds: 3000,
    });
    expect(intents).toEqual([]);
    expect(nextCursor).toBe(3000);
  });

  it("holds back an order that may still be filling", () => {
    const { intents, nextCursor } = selectCopyableIntents({
      trades,
      cursor: 0,
      nowSeconds: 3002,
      settleDelaySeconds: 5,
    });

    expect(intents.map((i) => i.timestamp)).toEqual([1000, 2000]);
    // Critically the cursor stops at 2000, so the held-back 3000 is still
    // picked up next tick rather than skipped forever.
    expect(nextCursor).toBe(2000);
  });

  it("advances the cursor only to the newest intent it actually returned", () => {
    const { nextCursor } = selectCopyableIntents({ trades, cursor: 0, nowSeconds: 9999 });
    expect(nextCursor).toBe(3000);
  });

  it("leaves the cursor untouched when there is nothing new", () => {
    const { intents, nextCursor } = selectCopyableIntents({
      trades: [],
      cursor: 1234,
      nowSeconds: 9999,
    });
    expect(intents).toEqual([]);
    expect(nextCursor).toBe(1234);
  });

  /**
   * 🚩 The regression this function was rewritten for, 2026-08-19.
   *
   * An order whose fills straddle a second boundary used to be copied twice:
   * the cursor advanced to the bucket's *earliest* fill, the later fills stayed
   * eligible, and on the next tick they re-formed as a bucket under a different
   * key — so the ledger's `intentKey` dedup never fired and each copy passed the
   * caps on its own.
   */
  describe("an order whose fills straddle a second boundary", () => {
    // One order, three fills, two timestamps. `/trades` keeps returning all of
    // them on every poll, which is what makes the second tick reachable.
    const straddling = [
      trade({ timestamp: 1000, size: 100, price: 0.3, transactionHash: "0xaaa" }),
      trade({ timestamp: 1000, size: 150, price: 0.31, transactionHash: "0xbbb" }),
      trade({ timestamp: 1001, size: 50, price: 0.32, transactionHash: "0xccc" }),
    ];

    it("is one intent carrying every fill", () => {
      const { intents, nextCursor } = selectCopyableIntents({
        trades: straddling,
        cursor: 500,
        nowSeconds: 1010,
      });

      expect(intents).toHaveLength(1);
      expect(intents[0].shares).toBe(300);
      expect(intents[0].fillCount).toBe(3);
      expect(nextCursor).toBe(1000);
    });

    it("is not copied again on the next tick", () => {
      const first = selectCopyableIntents({
        trades: straddling,
        cursor: 500,
        nowSeconds: 1010,
      });
      const second = selectCopyableIntents({
        trades: straddling,
        cursor: first.nextCursor,
        nowSeconds: 1030,
      });

      expect(second.intents).toEqual([]);
      expect(second.nextCursor).toBe(first.nextCursor);
    });
  });

  it("still emits an intent held back by the settle delay once it ages in", () => {
    // The case the cursor filter must not break: one intent inside the horizon
    // and one outside it, where the outside one starts *later* than the cursor
    // the inside one sets.
    const spanning = [
      trade({ timestamp: 1000, tokenId: "tok-a", transactionHash: "0xaaa" }),
      trade({ timestamp: 1001, tokenId: "tok-b", transactionHash: "0xbbb" }),
    ];

    const first = selectCopyableIntents({
      trades: spanning,
      cursor: 0,
      nowSeconds: 1005,
      settleDelaySeconds: 5,
    });
    expect(first.intents.map((i) => i.tokenId)).toEqual(["tok-a"]);
    expect(first.nextCursor).toBe(1000);

    const second = selectCopyableIntents({
      trades: spanning,
      cursor: first.nextCursor,
      nowSeconds: 1020,
      settleDelaySeconds: 5,
    });
    expect(second.intents.map((i) => i.tokenId)).toEqual(["tok-b"]);
    expect(second.nextCursor).toBe(1001);
  });

  it("does not re-copy a trade already past the cursor when newer ones arrive", () => {
    const first = selectCopyableIntents({ trades, cursor: 0, nowSeconds: 9999 });
    expect(first.intents.map((i) => i.timestamp)).toEqual([1000, 2000, 3000]);

    // The same page, plus one new trade. Only the new one is copyable.
    const withNewer = [...trades, trade({ timestamp: 4000, transactionHash: "0xddd" })];
    const second = selectCopyableIntents({
      trades: withNewer,
      cursor: first.nextCursor,
      nowSeconds: 9999,
    });
    expect(second.intents.map((i) => i.timestamp)).toEqual([4000]);
  });
});

describe("summariseBudget", () => {
  const NOW = Date.parse("2026-08-17T12:00:00.000Z");

  function entry(overrides: Partial<CopyLedgerEntry> = {}): CopyLedgerEntry {
    return {
      id: "e1",
      intentKey: "k1",
      address: WTSA,
      traderName: "WTSA",
      side: "BUY",
      tokenId: TIJUANA_YES,
      conditionId: "0xf43f26",
      title: "Will Club Tijuana win on 2026-08-16?",
      outcome: "Yes",
      slug: "mex-tij-caz-2026-08-16-tij",
      eventSlug: "mex-tij-caz-2026-08-16",
      decidedAt: "2026-08-17T10:00:00.000Z",
      sourceTimestamp: 1786932886,
      status: "placed",
      amountUsd: 25,
      ...overrides,
    };
  }

  it("takes midnight UTC as the daily boundary", () => {
    expect(utcDayStartMs(NOW)).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
  });

  it("counts only today's buys toward the daily figure", () => {
    const budget = summariseBudget(
      [
        entry({ id: "a", decidedAt: "2026-08-17T09:00:00.000Z", amountUsd: 25 }),
        entry({ id: "b", decidedAt: "2026-08-16T23:59:59.000Z", amountUsd: 40 }),
      ],
      WTSA,
      NOW,
    );

    expect(budget.spentTodayUsd).toBe(25);
    // Yesterday's buy still counts as deployed — the total cap is not a
    // rolling window, it is a standing exposure limit.
    expect(budget.deployedUsd).toBe(65);
  });

  it("counts queued and simulated copies against the caps", () => {
    // Both matter: a backed-up queue would otherwise authorise past the cap,
    // and a dry run would never exercise the cap logic at all.
    const budget = summariseBudget(
      [
        entry({ id: "a", status: "queued", amountUsd: 25 }),
        entry({ id: "b", status: "simulated", amountUsd: 25 }),
      ],
      WTSA,
      NOW,
    );
    expect(budget.spentTodayUsd).toBe(50);
  });

  it("ignores skipped, failed and cancelled rows", () => {
    const budget = summariseBudget(
      [
        entry({ id: "a", status: "skipped", amountUsd: 25 }),
        entry({ id: "b", status: "failed", amountUsd: 25 }),
        entry({ id: "c", status: "cancelled", amountUsd: 25 }),
      ],
      WTSA,
      NOW,
    );
    expect(budget).toEqual({ spentTodayUsd: 0, deployedUsd: 0 });
  });

  it("nets sells out of deployed capital without crediting the daily cap", () => {
    const budget = summariseBudget(
      [
        entry({ id: "a", side: "BUY", amountUsd: 100 }),
        entry({ id: "b", side: "SELL", amountUsd: 30 }),
      ],
      WTSA,
      NOW,
    );

    expect(budget.deployedUsd).toBe(70);
    // Closing a position must not refund the day's budget, or a user could
    // churn in and out and never hit the cap.
    expect(budget.spentTodayUsd).toBe(100);
  });

  it("never reports negative deployed capital", () => {
    const budget = summariseBudget(
      [
        entry({ id: "a", side: "BUY", amountUsd: 10 }),
        entry({ id: "b", side: "SELL", amountUsd: 50 }),
      ],
      WTSA,
      NOW,
    );
    expect(budget.deployedUsd).toBe(0);
  });

  it("keeps traders' budgets separate", () => {
    const budget = summariseBudget(
      [entry({ id: "a", address: "0xother", amountUsd: 999 })],
      WTSA,
      NOW,
    );
    expect(budget).toEqual({ spentTodayUsd: 0, deployedUsd: 0 });
  });

  describe("deployedUsdFor", () => {
    const ledger = [
      entry({ id: "a", side: "BUY", amountUsd: 100, decidedAt: "2026-08-16T09:00:00.000Z" }),
      entry({ id: "b", side: "SELL", amountUsd: 30, decidedAt: "2026-08-17T09:00:00.000Z" }),
      entry({ id: "c", status: "skipped", amountUsd: 500 }),
      entry({ id: "d", address: "0xother", amountUsd: 999 }),
    ];

    it("agrees with the figure summariseBudget reports", () => {
      expect(deployedUsdFor(ledger, WTSA)).toBe(summariseBudget(ledger, WTSA, NOW).deployedUsd);
      expect(deployedUsdFor(ledger, WTSA)).toBe(70);
    });

    /**
     * The property the split exists for: `CopyStats` renders this figure, and
     * reaching for it through `summariseBudget` meant passing `Date.now()`
     * during render for a number that never depended on it.
     */
    it("is the same answer whatever the clock says", () => {
      const longAgo = Date.parse("2020-01-01T00:00:00.000Z");
      const farFuture = Date.parse("2099-01-01T00:00:00.000Z");

      expect(summariseBudget(ledger, WTSA, longAgo).deployedUsd).toBe(70);
      expect(summariseBudget(ledger, WTSA, NOW).deployedUsd).toBe(70);
      expect(summariseBudget(ledger, WTSA, farFuture).deployedUsd).toBe(70);

      // …while the daily figure, sharing the same rows, moves with the clock —
      // which is what makes passing an arbitrary one at a render site a bug
      // waiting to be read rather than a harmless argument.
      expect(summariseBudget(ledger, WTSA, longAgo).spentTodayUsd).toBe(100);
      expect(summariseBudget(ledger, WTSA, NOW).spentTodayUsd).toBe(0);
      expect(summariseBudget(ledger, WTSA, farFuture).spentTodayUsd).toBe(0);
    });
  });
});

describe("decideCopy — entries", () => {
  const [intent] = groupFillsIntoIntents([trade()]);
  const budget = { spentTodayUsd: 0, deployedUsd: 0 };

  it("sizes a fixed copy independently of how large their trade was", () => {
    const decision = decideCopy({ intent, settings: DEFAULT_COPY_SETTINGS, budget });
    expect(decision).toEqual({ action: "buy", amountUsd: 25, cappedBy: null });
  });

  it("sizes a percent copy against their notional", () => {
    // 0.2% of the real $12,334.66 buy, floored to the cent.
    const decision = decideCopy({
      intent,
      settings: {
        ...DEFAULT_COPY_SETTINGS,
        sizing: { mode: "percent", percentOfTheirNotional: 0.2 },
        perTradeCapUsd: 100,
      },
      budget,
    });

    expect(decision).toEqual({ action: "buy", amountUsd: 24.66, cappedBy: null });
  });

  it("floors to the cent so a copy can never exceed the cap that sized it", () => {
    const decision = decideCopy({
      intent,
      settings: { ...DEFAULT_COPY_SETTINGS, sizing: { mode: "fixed", usd: 10 }, perTradeCapUsd: 7.999 },
      budget,
    });
    expect(decision).toEqual({ action: "buy", amountUsd: 7.99, cappedBy: "per_trade_cap" });
  });

  it("reports which cap sized the copy down", () => {
    const decision = decideCopy({
      intent,
      settings: { ...DEFAULT_COPY_SETTINGS, sizing: { mode: "fixed", usd: 50 }, dailyCapUsd: 100 },
      budget: { spentTodayUsd: 80, deployedUsd: 0 },
    });
    expect(decision).toEqual({ action: "buy", amountUsd: 20, cappedBy: "daily_cap" });
  });

  it("applies the tightest cap when several bind", () => {
    const decision = decideCopy({
      intent,
      settings: {
        sizing: { mode: "fixed", usd: 100 },
        perTradeCapUsd: 40,
        dailyCapUsd: 100,
        totalCapUsd: 500,
      },
      budget: { spentTodayUsd: 85, deployedUsd: 0 },
    });
    expect(decision).toEqual({ action: "buy", amountUsd: 15, cappedBy: "daily_cap" });
  });

  it("blames the cap, not the size, when a cap squeezes the copy below the floor", () => {
    // "Daily cap reached" is actionable; "too small to place" would read as a
    // sizing bug.
    const decision = decideCopy({
      intent,
      settings: { ...DEFAULT_COPY_SETTINGS, dailyCapUsd: 100 },
      budget: { spentTodayUsd: 99.5, deployedUsd: 0 },
    });
    expect(decision).toEqual({ action: "skip", reason: "daily_cap" });
  });

  it("reports below_minimum only when the requested size itself is too small", () => {
    const decision = decideCopy({
      intent,
      settings: {
        ...DEFAULT_COPY_SETTINGS,
        sizing: { mode: "percent", percentOfTheirNotional: 0.001 },
      },
      budget,
    });
    expect(decision).toEqual({ action: "skip", reason: "below_minimum" });
  });

  it("stops at the total cap on standing exposure", () => {
    const decision = decideCopy({
      intent,
      settings: { ...DEFAULT_COPY_SETTINGS, totalCapUsd: 500 },
      budget: { spentTodayUsd: 0, deployedUsd: 500 },
    });
    expect(decision).toEqual({ action: "skip", reason: "total_cap" });
  });

  it("refuses a settled market before anything else", () => {
    const decision = decideCopy({
      intent,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      marketClosed: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "market_closed" });
  });

  it("refuses a paused trader", () => {
    const decision = decideCopy({
      intent,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      paused: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "trader_paused" });
  });

  it("treats corrupt settings as a zero cap rather than trading on NaN", () => {
    const decision = decideCopy({
      intent,
      settings: {
        sizing: { mode: "fixed", usd: Number.NaN },
        perTradeCapUsd: Number.NaN,
        dailyCapUsd: -5,
        totalCapUsd: Number.NaN,
      },
      budget,
    });
    expect(decision.action).toBe("skip");
  });
});

describe("decideCopy — exits", () => {
  const [sell] = groupFillsIntoIntents([
    trade({ side: "SELL", size: 100, price: 0.5, transactionHash: "0xsell" }),
  ]);
  const budget = { spentTodayUsd: 0, deployedUsd: 0 };

  it("mirrors the fraction they closed, not the share count", () => {
    // They sold 100 of 400 held (300 left) = 25%. We hold 60 → sell 15.
    const decision = decideCopy({
      intent: sell,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      exit: { ourShares: 60, theirSharesAfter: 300 },
    });

    expect(decision).toEqual({ action: "sell", shares: 15, fraction: 0.25 });
  });

  it("snaps a near-total exit to a full one", () => {
    // 99.5% closed — the remaining 0.5% would be unsellable dust.
    const decision = decideCopy({
      intent: sell,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      exit: { ourShares: 60, theirSharesAfter: 0.5 },
    });

    expect(decision).toEqual({ action: "sell", shares: 60, fraction: 1 });
  });

  it("exits fully when their remaining position cannot be read", () => {
    // Over-exiting costs upside; under-exiting leaves a position the user
    // believes is closed.
    const decision = decideCopy({
      intent: sell,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      exit: { ourShares: 42, theirSharesAfter: null },
    });

    expect(decision).toEqual({ action: "sell", shares: 42, fraction: 1 });
  });

  it("skips when the user holds none of the outcome", () => {
    const decision = decideCopy({
      intent: sell,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      exit: { ourShares: 0, theirSharesAfter: 300 },
    });
    expect(decision).toEqual({ action: "skip", reason: "no_position_to_exit" });
  });

  it("skips an exit too small to be worth placing", () => {
    // 1% of 1 share at $0.50 is half a cent.
    const decision = decideCopy({
      intent: sell,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      exit: { ourShares: 1, theirSharesAfter: 9900 },
    });
    expect(decision).toEqual({ action: "skip", reason: "below_minimum" });
  });

  it("refuses to exit a settled market too", () => {
    const decision = decideCopy({
      intent: sell,
      settings: DEFAULT_COPY_SETTINGS,
      budget,
      marketClosed: true,
      exit: { ourShares: 60, theirSharesAfter: 300 },
    });
    expect(decision).toEqual({ action: "skip", reason: "market_closed" });
  });

  it("ignores a missing exit context rather than throwing", () => {
    const decision = decideCopy({ intent: sell, settings: DEFAULT_COPY_SETTINGS, budget });
    expect(decision).toEqual({ action: "skip", reason: "no_position_to_exit" });
  });
});
