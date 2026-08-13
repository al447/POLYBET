import type { UserEvent } from "@polymarket/bindings/subscriptions";

import type { BrowserClient } from "@/lib/polymarket/browser-client";

/**
 * Live user channel — fills, order status, and the cache invalidation they
 * imply (FR-4.5, Step 3.7).
 *
 * The mirror image of `market-data.ts`: that one reads the *public* feed with
 * no wallet at all, this one rides the user's own **authenticated** client, so
 * everything here requires a connected wallet and the L2 credentials
 * `createSecureClient` already holds. There is no server involvement — same
 * browser-side pattern as `portfolio.ts` and `OpenOrdersPanel`.
 *
 * ⚠️ **This channel reports events; it does not carry state.** A fill tells
 * you a position and a balance changed, not what they changed *to* — the
 * payload has no post-trade position size or cash figure. So `revision` below
 * is the useful output for most consumers: a counter that says "your cached
 * reads are stale, refetch," not a value to render.
 */

/** One matched trade, as much of it as the UI actually needs. */
export type UserFill = {
  /** Trade id. Stable across the status progression below. */
  id: string;
  tokenId: string;
  market: string;
  side: string;
  size: number;
  price: number;
  /** `TRADE_STATUS_*` — see the dedupe note on `applyUserEvent`. */
  status: string;
  outcome: string | null;
  timestamp: number;
};

/** The last thing that happened to one of the user's resting orders. */
export type UserOrderUpdate = {
  id: string;
  tokenId: string;
  /** `PLACEMENT` | `UPDATE` | `CANCELLATION`. */
  eventType: string;
  /** `LIVE` | `MATCHED` | `DELAYED` | `UNMATCHED` | `CANCELED`, when the server sends one. */
  status: string | null;
  originalSize: number;
  sizeMatched: number;
  timestamp: number;
};

export type UserChannelState = {
  /** Most recent first, capped at `MAX_FILLS`. One entry per trade id. */
  fills: UserFill[];
  lastOrderUpdate: UserOrderUpdate | null;
  /**
   * Increments on every event that invalidates a cached read (positions, cash
   * balance, open orders). Consumers watch this instead of diffing fills —
   * `useEffect(..., [revision])` is the whole integration.
   */
  revision: number;
};

export const EMPTY_USER_CHANNEL_STATE: UserChannelState = {
  fills: [],
  lastOrderUpdate: null,
  revision: 0,
};

/** Enough to render a toast stack and a short "recent fills" list; this is not a history feed (FR-4.4). */
const MAX_FILLS = 20;

/**
 * Subscribes to the authenticated user channel. Returns the SDK's
 * `SubscriptionHandle` — an `AsyncIterable` plus `close()` — consumed with
 * `for await` by `useUserChannel`.
 *
 * Subscribes to *all* the user's markets rather than the one on screen: the
 * portfolio needs every fill, and a second socket per screen would spend
 * connections to deliver a strict subset of what this one already carries.
 */
export async function subscribeUserChannel(client: BrowserClient) {
  return client.subscribe([{ topic: "user" }]);
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pure reducer — applies one user event to the previous state. Side-effect
 * free so it's unit-testable without a live socket, same convention as
 * `applyMarketEvent` (this repo has no jsdom/RTL; only pure functions are
 * tested — see `user-events.test.ts`).
 *
 * ⚠️ **A single trade arrives repeatedly.** Its `status` walks
 * `MATCHED → MINED → CONFIRMED` (and can end at `FAILED`/`RETRYING`), each as
 * a separate event carrying the same trade id. Appending blindly would show a
 * user three toasts for one fill, so a repeat id **replaces** the existing
 * entry in place — keeping its original position in the list — rather than
 * being prepended as a new fill. Consumers key on `id` and see one fill whose
 * status advances.
 */
export function applyUserEvent(state: UserChannelState, event: UserEvent): UserChannelState {
  switch (event.type) {
    case "trade": {
      const { payload } = event;
      const fill: UserFill = {
        id: payload.id,
        tokenId: payload.tokenId,
        market: payload.market,
        side: payload.side,
        size: toNumber(payload.size),
        price: toNumber(payload.price),
        status: payload.status,
        outcome: payload.outcome ?? null,
        timestamp: toNumber(payload.timestamp),
      };

      const existing = state.fills.findIndex((f) => f.id === fill.id);
      const fills =
        existing >= 0
          ? state.fills.map((f, i) => (i === existing ? fill : f))
          : [fill, ...state.fills].slice(0, MAX_FILLS);

      return { ...state, fills, revision: state.revision + 1 };
    }
    case "order": {
      const { payload } = event;
      return {
        ...state,
        lastOrderUpdate: {
          id: payload.id,
          tokenId: payload.tokenId,
          eventType: payload.orderEventType,
          status: payload.status ?? null,
          originalSize: toNumber(payload.originalSize),
          sizeMatched: toNumber(payload.sizeMatched),
          timestamp: toNumber(payload.timestamp),
        },
        revision: state.revision + 1,
      };
    }
    default:
      return state;
  }
}
