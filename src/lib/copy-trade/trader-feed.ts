import { POLYMARKET_ENDPOINTS } from "@/lib/polymarket/config";

import type { TraderTrade } from "./types";

/**
 * Reads of a **followed trader's** public activity — what they bought, and how
 * much of it they still hold.
 *
 * Runs in the browser, deliberately, for the same structural reason as
 * `portfolio.ts` rather than as a cached server proxy like `gamma.ts`:
 *
 *  - It is **per-followed-trader**, so there is no shared result to cache. Two
 *    users following two different traders share nothing.
 *  - It **must not be stale**. `gamma.ts` caches a market list for 60s because
 *    a slightly old list is harmless. A 60s-old trade feed means every copy is
 *    up to a minute late, which is the one property that decides whether
 *    copying is worth anything at all. A `"use cache"` here would be a
 *    correctness bug, exactly like caching a price.
 *
 * `data-api.polymarket.com` is already in the CSP `connect-src` (next.config.ts)
 * for `portfolio.ts` and `activity.ts`, so this needs no policy change.
 *
 * ⚠️ Everything here reads **other people's** public data. It is never
 * authenticated and must never carry a credential — these are the same numbers
 * the Polymarket website shows on a public profile.
 *
 * Endpoints verified live 2026-08-17. Parsing is split from fetching so the
 * wire quirks are unit-tested without a network.
 */

const REQUEST_TIMEOUT_MS = 8000;

/**
 * How many rows to pull per poll.
 *
 * 🚩 Not a page size in the usual sense — there is **no cap** on this endpoint.
 * Asking for 500 returned a trader's entire 279-row history, so a large value
 * plus an unseeded cursor is what would replay someone's whole trading career
 * as live copies. 100 is generous for one poll interval while keeping the
 * response small; the cursor in `selectCopyableIntents` is what actually
 * bounds what gets acted on.
 */
export const TRADE_POLL_LIMIT = 100;

/** Returns `null` rather than throwing, so one trader's outage cannot stop the whole poll. */
async function dataApiFetch<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // The caller's signal (the hook unmounting) and our timeout both need to
  // abort the same request.
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(`${POLYMARKET_ENDPOINTS.data}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Normalises `/trades` rows into `TraderTrade`.
 *
 * Verified wire shape, 2026-08-17:
 *
 * ```json
 * { "proxyWallet":"0x04d5…66d8", "side":"BUY",
 *   "asset":"64921565…95123", "conditionId":"0xf43f26…",
 *   "size":38132.38, "price":0.3234694976, "timestamp":1786932886,
 *   "title":"Will Club Tijuana win on 2026-08-16?", "outcome":"Yes",
 *   "slug":"mex-tij-caz-2026-08-16-tij", "eventSlug":"mex-tij-caz-2026-08-16",
 *   "transactionHash":"0xcf987e…" }
 * ```
 *
 * Two renames are deliberate. `asset` becomes **`tokenId`** because that is
 * what `placeMarketBuy` calls it, and an order call site reading `asset` is one
 * rename away from passing a condition id instead. `proxyWallet` becomes
 * `address`, matching `LeaderboardTrader`.
 *
 * ⚠️ `timestamp` is Unix **seconds**. Multiplying by 1000 somewhere downstream
 * and comparing against a seconds cursor would make every trade look like it
 * happened in the far future — and be copied forever.
 *
 * Rows that cannot be acted on are dropped here rather than filtered later:
 * anything without a token id or a recognised side is not a trade we could
 * mirror even in principle.
 */
export function parseTraderTrades(payload: unknown, fallbackAddress: string): TraderTrade[] {
  if (!Array.isArray(payload)) return [];

  const trades: TraderTrade[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const tokenId = str(row.asset);
    const side = str(row.side).toUpperCase();
    if (!tokenId) continue;
    if (side !== "BUY" && side !== "SELL") continue;

    trades.push({
      address: (str(row.proxyWallet) || fallbackAddress).toLowerCase(),
      side,
      tokenId,
      conditionId: str(row.conditionId),
      size: num(row.size),
      price: num(row.price),
      timestamp: num(row.timestamp),
      title: str(row.title),
      outcome: str(row.outcome),
      slug: str(row.slug),
      eventSlug: str(row.eventSlug),
      icon: str(row.icon) || undefined,
      transactionHash: str(row.transactionHash),
    });
  }

  return trades;
}

/**
 * A trader's current holdings, as `tokenId → shares`.
 *
 * A map rather than a list because there is exactly one question asked of it:
 * "how much of this one token do they still hold, now that the sell has
 * landed?" — the denominator for a proportional exit. See `decideCopy`.
 *
 * Verified shape 2026-08-17: `{ asset, conditionId, size, avgPrice,
 * currentValue, title, outcome, redeemable }`. Note this endpoint accepts **any**
 * address, not just your own — which is what makes mirroring an exit possible
 * at all.
 */
export function parseTraderPositionSizes(payload: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!Array.isArray(payload)) return sizes;

  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const tokenId = str(row.asset);
    if (!tokenId) continue;

    const size = num(row.size);
    if (size > 0) sizes.set(tokenId, size);
  }

  return sizes;
}

/** Recent trades for one trader, newest first as the API returns them. */
export async function fetchTraderTrades(
  address: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TraderTrade[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? TRADE_POLL_LIMIT));
  const query = new URLSearchParams({ user: address, limit: String(limit) });

  const payload = await dataApiFetch<unknown>(`/trades?${query.toString()}`, options.signal);
  return parseTraderTrades(payload, address);
}

/**
 * A trader's open position sizes.
 *
 * Returns an **empty map** on failure, which `decideCopy` reads as "their
 * remaining size is unknown" and answers with a full exit. That is the
 * deliberate safe direction — see the warning on `decideExit`.
 */
export async function fetchTraderPositionSizes(
  address: string,
  options: { signal?: AbortSignal } = {},
): Promise<Map<string, number>> {
  const query = new URLSearchParams({ user: address, limit: "500" });

  const payload = await dataApiFetch<unknown>(`/positions?${query.toString()}`, options.signal);
  return parseTraderPositionSizes(payload);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Coerces defensively: a missing or non-numeric field must read as 0, never NaN. */
function num(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}
