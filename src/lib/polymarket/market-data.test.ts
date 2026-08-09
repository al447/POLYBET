import { describe, expect, it } from "vitest";

import { applyMarketEvent, type OrderBookState } from "./market-data";
import type { MarketEvent } from "@polymarket/client/actions";

// Minimal event fixtures matching the shape confirmed in
// node_modules/@polymarket/bindings/dist/subscriptions/index.d.ts — only the
// fields `applyMarketEvent` actually reads. Cast through `unknown` rather
// than typing out the SDK's full branded (`DecimalString`/`TokenId`) fields.
function asEvent(event: Record<string, unknown>): MarketEvent {
  return event as unknown as MarketEvent;
}

function bookEvent(bids: [string, string][], asks: [string, string][]) {
  return asEvent({
    topic: "market",
    type: "book",
    payload: {
      tokenId: "1",
      market: "0xabc",
      bids: bids.map(([price, size]) => ({ price, size })),
      asks: asks.map(([price, size]) => ({ price, size })),
      lastTradePrice: null,
      tickSize: "0.01",
    },
  });
}

function priceChangeEvent(changes: { side: "BUY" | "SELL"; price: string; size: string }[]) {
  return asEvent({
    topic: "market",
    type: "price_change",
    payload: {
      market: "0xabc",
      priceChanges: changes.map((c) => ({ tokenId: "1", ...c })),
    },
  });
}

describe("applyMarketEvent — book snapshot", () => {
  it("replaces state entirely and sorts bids desc / asks asc", () => {
    const state = applyMarketEvent(null, bookEvent([["0.40", "100"], ["0.42", "50"]], [["0.45", "80"], ["0.43", "60"]]));
    expect(state?.bids.map((b) => b.price)).toEqual([0.42, 0.4]);
    expect(state?.asks.map((a) => a.price)).toEqual([0.43, 0.45]);
  });

  it("overwrites a previous snapshot rather than merging with it", () => {
    const first = applyMarketEvent(null, bookEvent([["0.40", "100"]], [["0.45", "80"]]));
    const second = applyMarketEvent(first, bookEvent([["0.50", "10"]], [["0.55", "10"]]));
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
    const next = applyMarketEvent(snapshot, priceChangeEvent([{ side: "BUY", price: "0.41", size: "20" }]));
    expect(next?.bids).toEqual([
      { price: 0.41, size: 20 },
      { price: 0.4, size: 100 },
    ]);
  });

  it("updates an existing ask level's size", () => {
    const next = applyMarketEvent(snapshot, priceChangeEvent([{ side: "SELL", price: "0.45", size: "5" }]));
    expect(next?.asks).toEqual([{ price: 0.45, size: 5 }]);
  });

  it("removes a level when size is zero", () => {
    const next = applyMarketEvent(snapshot, priceChangeEvent([{ side: "BUY", price: "0.4", size: "0" }]));
    expect(next?.bids).toEqual([]);
  });

  it("is dropped when there is no prior snapshot", () => {
    const next = applyMarketEvent(null, priceChangeEvent([{ side: "BUY", price: "0.4", size: "100" }]));
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
    );
    expect(next?.tickSize).toBe(0.001);
  });

  it("ignores an unknown event type as a no-op", () => {
    const next = applyMarketEvent(
      snapshot,
      asEvent({ topic: "market", type: "new_market", payload: {} }),
    );
    expect(next).toBe(snapshot);
  });
});
