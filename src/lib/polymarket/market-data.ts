import { createPublicClient, OrderSide } from "@polymarket/client";
import type { MarketEvent, MarketSubscription } from "@polymarket/client/actions";

/**
 * Live market data (order book, last trade) — unauthenticated (FR-3.4, Step
 * 3.1). Distinct from `browser-client.ts`, which builds the *authenticated*
 * signer used for orders: nothing here ever touches a wallet, a session, or
 * a builder credential — it's the same public feed polymarket.com itself
 * reads from.
 */

export type OrderBookLevel = { price: number; size: number };

export type OrderBookState = {
  /** Sorted descending by price — best bid first. */
  bids: OrderBookLevel[];
  /** Sorted ascending by price — best ask first. */
  asks: OrderBookLevel[];
  lastTradePrice: number | null;
  tickSize: number | null;
};

/** Depth beyond this is dropped — the UI only ever shows a handful of levels. */
const MAX_DEPTH = 25;

let publicClient: ReturnType<typeof createPublicClient> | undefined;

function getPublicMarketClient() {
  publicClient ??= createPublicClient();
  return publicClient;
}

/**
 * Subscribes to the live order book for the given token IDs. Returns the
 * SDK's `SubscriptionHandle` — an `AsyncIterable` plus `close()` — consumed
 * with `for await` by `useOrderBook`.
 *
 * `subscribe` is dynamically imported from `/actions` to match this
 * codebase's existing lazy-load convention for that (large) subpath — see
 * `browser-client.ts`.
 */
export async function subscribeOrderBook(tokenIds: readonly string[]) {
  const { subscribe } = await import("@polymarket/client/actions");
  const subscriptions: readonly [MarketSubscription] = [{ topic: "market", tokenIds }];
  return subscribe(getPublicMarketClient(), subscriptions);
}

function sortBids(levels: OrderBookLevel[]): OrderBookLevel[] {
  return [...levels].sort((a, b) => b.price - a.price).slice(0, MAX_DEPTH);
}

function sortAsks(levels: OrderBookLevel[]): OrderBookLevel[] {
  return [...levels].sort((a, b) => a.price - b.price).slice(0, MAX_DEPTH);
}

/** Replaces the level at `price`, or removes it when `size` is zero (the WS convention for a cleared level). */
function upsertLevel(levels: OrderBookLevel[], price: number, size: number): OrderBookLevel[] {
  const next = levels.filter((level) => level.price !== price);
  if (size > 0) next.push({ price, size });
  return next;
}

/**
 * Pure reducer — applies one WS event to the previous book state. Kept
 * side-effect-free so it's unit-testable without a real WebSocket (this repo
 * has no jsdom/React Testing Library; only pure-function tests exist — see
 * `market-data.test.ts`, `fees.test.ts`, `gamma.test.ts`).
 *
 * A `price_change` arriving with no prior `book` snapshot (`state === null`)
 * is dropped rather than guessed at — there's nothing safe to apply a delta
 * to. `useOrderBook` resets state to `null` on every fresh subscribe, so a
 * dropped delta just means "wait for the snapshot," never a corrupted book.
 *
 * Typed against `MarketEvent` (the full union, including the custom-feature
 * events like `best_bid_ask`) rather than the narrower `StandardMarketEvent`
 * — TS resolves `subscribe()`'s return type to `MarketEvent` here regardless
 * of `customFeatureEnabled` being unset, since `MarketSubscription` isn't a
 * literal-narrowed const. The `default` branch below already handles any
 * event type we don't explicitly care about, so this is a no-op in practice.
 */
export function applyMarketEvent(
  state: OrderBookState | null,
  event: MarketEvent,
): OrderBookState | null {
  switch (event.type) {
    case "book": {
      const { bids, asks, lastTradePrice, tickSize } = event.payload;
      return {
        bids: sortBids(bids.map((level) => ({ price: Number(level.price), size: Number(level.size) }))),
        asks: sortAsks(asks.map((level) => ({ price: Number(level.price), size: Number(level.size) }))),
        lastTradePrice: lastTradePrice ? Number(lastTradePrice) : null,
        tickSize: tickSize ? Number(tickSize) : null,
      };
    }
    case "price_change": {
      if (!state) return state;
      let { bids, asks } = state;
      for (const change of event.payload.priceChanges) {
        const price = Number(change.price);
        const size = Number(change.size);
        if (change.side === OrderSide.BUY) {
          bids = upsertLevel(bids, price, size);
        } else {
          asks = upsertLevel(asks, price, size);
        }
      }
      return { ...state, bids: sortBids(bids), asks: sortAsks(asks) };
    }
    case "last_trade_price":
      return state ? { ...state, lastTradePrice: Number(event.payload.price) } : state;
    case "tick_size_change":
      return state ? { ...state, tickSize: Number(event.payload.newTickSize) } : state;
    default:
      return state;
  }
}
