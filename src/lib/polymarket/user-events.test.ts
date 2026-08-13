import { describe, expect, it } from "vitest";
import type { UserEvent } from "@polymarket/bindings/subscriptions";

import { applyUserEvent, EMPTY_USER_CHANNEL_STATE, type UserChannelState } from "./user-events";

// Minimal fixtures matching the transform *output* shape confirmed in
// node_modules/@polymarket/bindings/dist/subscriptions/index.d.ts (the wire
// format is snake_case; the SDK's zod pipe hands us camelCase under
// `{topic, type, payload}`). Only the fields the reducer reads are filled in;
// cast through `unknown` rather than typing out the branded
// `DecimalString`/`TokenId`/`TradeStatus` fields, as market-data.test.ts does.
function asEvent(event: Record<string, unknown>): UserEvent {
  return event as unknown as UserEvent;
}

function tradeEvent(overrides: Record<string, unknown> = {}) {
  return asEvent({
    topic: "user",
    type: "trade",
    payload: {
      id: "trade-1",
      tokenId: "token-1",
      market: "0xabc",
      side: "BUY",
      size: "12.5",
      price: "0.42",
      status: "TRADE_STATUS_MATCHED",
      outcome: "Yes",
      timestamp: 1_700_000_000_000,
      ...overrides,
    },
  });
}

function orderEvent(overrides: Record<string, unknown> = {}) {
  return asEvent({
    topic: "user",
    type: "order",
    payload: {
      id: "order-1",
      tokenId: "token-1",
      market: "0xabc",
      orderEventType: "PLACEMENT",
      status: "LIVE",
      originalSize: "100",
      sizeMatched: "0",
      side: "BUY",
      price: "0.40",
      timestamp: 1_700_000_000_000,
      ...overrides,
    },
  });
}

describe("applyUserEvent — trades", () => {
  it("records a fill with parsed numbers", () => {
    const state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent());
    expect(state.fills).toHaveLength(1);
    expect(state.fills[0]).toMatchObject({
      id: "trade-1",
      tokenId: "token-1",
      side: "BUY",
      size: 12.5,
      price: 0.42,
      status: "TRADE_STATUS_MATCHED",
      outcome: "Yes",
    });
  });

  it("prepends distinct fills, newest first", () => {
    let state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent({ id: "trade-1" }));
    state = applyUserEvent(state, tradeEvent({ id: "trade-2" }));
    expect(state.fills.map((f) => f.id)).toEqual(["trade-2", "trade-1"]);
  });

  it("replaces a repeated trade id in place as its status advances", () => {
    // The status progression MATCHED → MINED → CONFIRMED arrives as separate
    // events for one trade. Appending each would toast the user three times
    // for a single fill.
    let state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent({ id: "trade-1" }));
    state = applyUserEvent(state, tradeEvent({ id: "trade-2" }));
    state = applyUserEvent(state, tradeEvent({ id: "trade-1", status: "TRADE_STATUS_CONFIRMED" }));

    expect(state.fills).toHaveLength(2);
    expect(state.fills.map((f) => f.id)).toEqual(["trade-2", "trade-1"]);
    expect(state.fills.find((f) => f.id === "trade-1")?.status).toBe("TRADE_STATUS_CONFIRMED");
  });

  it("caps the fill log rather than growing without bound", () => {
    let state: UserChannelState = EMPTY_USER_CHANNEL_STATE;
    for (let i = 0; i < 30; i += 1) {
      state = applyUserEvent(state, tradeEvent({ id: `trade-${i}` }));
    }
    expect(state.fills).toHaveLength(20);
    expect(state.fills[0].id).toBe("trade-29");
  });

  it("tolerates an unparseable size or price instead of rendering NaN", () => {
    const state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent({ size: "", price: null }));
    expect(state.fills[0].size).toBe(0);
    expect(state.fills[0].price).toBe(0);
  });

  it("defaults a missing outcome to null", () => {
    const state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent({ outcome: undefined }));
    expect(state.fills[0].outcome).toBeNull();
  });
});

describe("applyUserEvent — orders", () => {
  it("keeps only the latest order update", () => {
    let state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, orderEvent({ id: "order-1" }));
    state = applyUserEvent(state, orderEvent({ id: "order-2", orderEventType: "CANCELLATION", status: "CANCELED" }));

    expect(state.lastOrderUpdate).toMatchObject({
      id: "order-2",
      eventType: "CANCELLATION",
      status: "CANCELED",
    });
  });

  it("parses partial-fill sizes and tolerates a null status", () => {
    const state = applyUserEvent(
      EMPTY_USER_CHANNEL_STATE,
      orderEvent({ originalSize: "100", sizeMatched: "37.5", status: null }),
    );
    expect(state.lastOrderUpdate).toMatchObject({ originalSize: 100, sizeMatched: 37.5, status: null });
  });

  it("does not touch the fill log", () => {
    const withFill = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent());
    const state = applyUserEvent(withFill, orderEvent());
    expect(state.fills).toEqual(withFill.fills);
  });
});

describe("applyUserEvent — revision", () => {
  it("increments on every event, so consumers can refetch on a single dependency", () => {
    let state = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent({ id: "trade-1" }));
    expect(state.revision).toBe(1);
    state = applyUserEvent(state, orderEvent());
    expect(state.revision).toBe(2);
    // Even a duplicate trade id bumps it: the status changed, and a
    // MINED → CONFIRMED transition is exactly when a balance settles.
    state = applyUserEvent(state, tradeEvent({ id: "trade-1", status: "TRADE_STATUS_MINED" }));
    expect(state.revision).toBe(3);
  });

  it("ignores an unknown event type without disturbing state", () => {
    const before = applyUserEvent(EMPTY_USER_CHANNEL_STATE, tradeEvent());
    const after = applyUserEvent(before, asEvent({ topic: "user", type: "something_new", payload: {} }));
    expect(after).toBe(before);
  });
});
