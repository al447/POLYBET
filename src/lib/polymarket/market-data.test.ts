import { describe, expect, it } from "vitest";

import { applyMarketEvent, type OrderBookState } from "./market-data";
import type { MarketEvent } from "@polymarket/client/actions";

// Minimal event fixtures matching the shape confirmed in
// node_modules/@polymarket/bindings/dist/subscriptions/index.d.ts — only the
// fields `applyMarketEvent` actually reads. Cast through `unknown` rather
// than typing out the SDK's full branded (`DecimalString`/`TokenId`) fields.
const TOKEN = "1";
const OTHER_TOKEN = "2";

function asEvent(event: Record<string, unknown>): MarketEvent {
  return event as unknown as MarketEvent;
}

function bookEvent(bids: [string, string][], asks: [string, string][], tokenId = TOKEN) {
  return asEvent({
    topic: "market",
    type: "book",
    payload: {
      tokenId,
      market: "0xabc",
      bids: bids.map(([price, size]) => ({ price, size })),
      asks: asks.map(([price, size]) => ({ price, size })),
      lastTradePrice: null,
      tickSize: "0.01",
    },
  });
}

function priceChangeEvent(
  changes: { side: "BUY" | "SELL"; price: string; size: string; tokenId?: string }[],
) {
  return asEvent({
    topic: "market",
    type: "price_change",
    payload: {
      market: "0xabc",
      priceChanges: changes.map((c) => ({ tokenId: TOKEN, ...c })),
    },
  });
}

describe("applyMarketEvent — book snapshot", () => {
  it("replaces state entirely and sorts bids desc / asks asc", () => {
    const state = applyMarketEvent(null, bookEvent([["0.40", "100"], ["0.42", "50"]], [["0.45", "80"], ["0.43", "60"]]), TOKEN);
    expect(state?.bids.map((b) => b.price)).toEqual([0.42, 0.4]);
    expect(state?.asks.map((a) => a.price)).toEqual([0.43, 0.45]);
  });

  it("overwrites a previous snapshot rather than merging with it", () => {
    const first = applyMarketEvent(null, bookEvent([["0.40", "100"]], [["0.45", "80"]]), TOKEN);
    const second = applyMarketEvent(first, bookEvent([["0.50", "10"]], [["0.55", "10"]]), TOKEN);
    expect(second?.bids).toEqual([{ price: 0.5, size: 10 }]);
    expect(second?.asks).toEqual([{ price: 0.55, size: 10 }]);
  });
});

describe("applyMarketEvent — price_change", () => {
  const snapshot: OrderBookState = {
    bids: [{ price: 0.4, size: 100 }],
    asks: [{ price: 0.45, size: 80 }],
    lastTradePrice: null,
    tickSize: 0.01,
  };

  it("inserts a new bid level", () => {
    const next = applyMarketEvent(snapshot, priceChangeEvent([{ side: "BUY", price: "0.41", size: "20" }]), TOKEN);
    expect(next?.bids).toEqual([
      { price: 0.41, size: 20 },
      { price: 0.4, size: 100 },
    ]);
  });

  it("updates an existing ask level's size", () => {
    const next = applyMarketEvent(snapshot, priceChangeEvent([{ side: "SELL", price: "0.45", size: "5" }]), TOKEN);
    expect(next?.asks).toEqual([{ price: 0.45, size: 5 }]);
  });

  it("removes a level when size is zero", () => {
    const next = applyMarketEvent(snapshot, priceChangeEvent([{ side: "BUY", price: "0.4", size: "0" }]), TOKEN);
    expect(next?.bids).toEqual([]);
  });

  it("is dropped when there is no prior snapshot", () => {
    const next = applyMarketEvent(null, priceChangeEvent([{ side: "BUY", price: "0.4", size: "100" }]), TOKEN);
    expect(next).toBeNull();
  });
});

describe("applyMarketEvent — last_trade_price / tick_size_change", () => {
  const snapshot: OrderBookState = {
    bids: [{ price: 0.4, size: 100 }],
    asks: [{ price: 0.45, size: 80 }],
    lastTradePrice: null,
    tickSize: 0.01,
  };

  it("updates only lastTradePrice, leaving bids/asks untouched", () => {
    const next = applyMarketEvent(
      snapshot,
      asEvent({
        topic: "market",
        type: "last_trade_price",
        payload: { tokenId: "1", market: "0xabc", price: "0.44", side: "BUY" },
      }),
      TOKEN,
    );
    expect(next?.lastTradePrice).toBe(0.44);
    expect(next?.bids).toBe(snapshot.bids);
    expect(next?.asks).toBe(snapshot.asks);
  });

  it("updates only tickSize", () => {
    const next = applyMarketEvent(
      snapshot,
      asEvent({
        topic: "market",
        type: "tick_size_change",
        payload: { tokenId: "1", market: "0xabc", newTickSize: "0.001" },
      }),
      TOKEN,
    );
    expect(next?.tickSize).toBe(0.001);
  });

  it("ignores an unknown event type as a no-op", () => {
    const next = applyMarketEvent(
      snapshot,
      asEvent({ topic: "market", type: "new_market", payload: {} }),
      TOKEN,
    );
    expect(next).toBe(snapshot);
  });
});

/**
 * 🚩 The regression. A single-token subscription still receives the other
 * outcome's deltas in the same price_change event (measured live 2026-11-19,
 * 1:1 with ours). Applying them put the NO book's ~88¢ bids into a ~10¢ YES
 * book and showed a −78¢ spread.
 */
describe("applyMarketEvent — other token's events", () => {
  const snapshot: OrderBookState = {
    bids: [{ price: 0.09, size: 100 }],
    asks: [{ price: 0.1, size: 80 }],
    lastTradePrice: 0.1,
    tickSize: 0.01,
  };

  it("applies only this token's changes from a mixed price_change", () => {
    const next = applyMarketEvent(
      snapshot,
      priceChangeEvent([
        { side: "BUY", price: "0.88", size: "22400", tokenId: OTHER_TOKEN },
        { side: "SELL", price: "0.91", size: "500", tokenId: OTHER_TOKEN },
        { side: "BUY", price: "0.095", size: "40" },
      ]),
      TOKEN,
    );

    expect(next?.bids).toEqual([
      { price: 0.095, size: 40 },
      { price: 0.09, size: 100 },
    ]);
    expect(next?.asks).toEqual([{ price: 0.1, size: 80 }]);
  });

  it("never leaves the book crossed from the other token's bids", () => {
    const next = applyMarketEvent(
      snapshot,
      priceChangeEvent([{ side: "BUY", price: "0.88", size: "22400", tokenId: OTHER_TOKEN }]),
      TOKEN,
    );
    const bestBid = next?.bids[0]?.price ?? 0;
    const bestAsk = next?.asks[0]?.price ?? 1;
    expect(bestBid).toBeLessThan(bestAsk);
  });

  it("ignores another token's book snapshot", () => {
    const next = applyMarketEvent(snapshot, bookEvent([["0.88", "1"]], [["0.9", "1"]], OTHER_TOKEN), TOKEN);
    expect(next).toBe(snapshot);
  });

  it("ignores another token's last trade and tick size", () => {
    const trade = applyMarketEvent(
      snapshot,
      asEvent({
        topic: "market",
        type: "last_trade_price",
        payload: { tokenId: OTHER_TOKEN, market: "0xabc", price: "0.9", side: "BUY" },
      }),
      TOKEN,
    );
    const tick = applyMarketEvent(
      snapshot,
      asEvent({
        topic: "market",
        type: "tick_size_change",
        payload: { tokenId: OTHER_TOKEN, market: "0xabc", newTickSize: "0.001" },
      }),
      TOKEN,
    );
    expect(trade).toBe(snapshot);
    expect(tick).toBe(snapshot);
  });
});
