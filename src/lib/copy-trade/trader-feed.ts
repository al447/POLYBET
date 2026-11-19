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
 * 🚩 Data API v1 was retired 2026-11-02 — `/trades` and `/positions` are now a
 * 410, which this file read as "no trades" for two weeks. Moved to `/v2/trades`
 * and `/v2/positions`, re-verified live 2026-11-19 against
 * `data-api.polymarket.com/v2/openapi.json`. Every v2 payload arrives wrapped
 * in `{ data, pagination }` with snake_case fields; `offset` is a 400.
 *
 * Parsing is split from fetching so the wire quirks are unit-tested without a
 * network.
 */

const REQUEST_TIMEOUT_MS = 8000;

/**
 * How many rows to pull per poll.
 *
 * 🚩 Not a page size in the usual sense — v2 allows up to 1000 rows, so a large value
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

/** The row array inside a v2 `{ data, pagination }` envelope, or `null` if there isn't one. */
function rowsOf(payload: unknown): unknown[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : null;
}

/**
 * Normalises a `/v2/trades` page into `TraderTrade`.
 *
 * Verified wire row, 2026-11-19 (`taker_only` defaults to `true`, as v1 did, so
 * each fill still arrives once):
 *
 * ```json
 * { "proxy_wallet":"0x2ecb…ecb8", "side":"BUY",
 *   "token_id":"54392372…93391", "condition_id":"0x4c3844…",
 *   "size":3499.47, "price":0.957, "timestamp":1795081472,
 *   "title":"Will Tim Cook be the next CEO of NVIDIA?", "outcome":"No",
 *   "slug":"will-tim-cook-be-the-next-ceo-of-nvidia", "event_slug":"next-ceo-of-nvidia",
 *   "transaction_hash":"0xa6111c…" }
 * ```
 *
 * `token_id` becomes **`tokenId`** because that is what `placeMarketBuy` calls
 * it, and `condition_id` is the easy wrong answer at an order call site.
 * `proxy_wallet` becomes `address`, matching `LeaderboardTrader`.
 *
 * ⚠️ `timestamp` is Unix **seconds** (v2's own schema: "block timestamp of the
 * fill, epoch seconds"), so stored cursors and ledger intent keys from v1 still
 * line up. Multiplying by 1000 somewhere downstream
 * and comparing against a seconds cursor would make every trade look like it
 * happened in the far future — and be copied forever.
 *
 * Rows that cannot be acted on are dropped here rather than filtered later:
 * anything without a token id or a recognised side is not a trade we could
 * mirror even in principle.
 */
export function parseTraderTrades(payload: unknown, fallbackAddress: string): TraderTrade[] {
  const rows = rowsOf(payload);
  if (!rows) return [];

  const trades: TraderTrade[] = [];
  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const tokenId = str(row.token_id);
    const side = str(row.side).toUpperCase();
    if (!tokenId) continue;
    if (side !== "BUY" && side !== "SELL") continue;

    trades.push({
      address: (str(row.proxy_wallet) || fallbackAddress).toLowerCase(),
      side,
      tokenId,
      conditionId: str(row.condition_id),
      size: num(row.size),
      price: num(row.price),
      timestamp: num(row.timestamp),
      title: str(row.title),
      outcome: str(row.outcome),
      slug: str(row.slug),
      eventSlug: str(row.event_slug),
      icon: str(row.icon) || undefined,
      transactionHash: str(row.transaction_hash),
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
 * Verified v2 row 2026-11-19: `{ token_id, condition_id, current_size,
 * total_size, avg_price, current_value, status, redeemable, … }`. Note this
 * endpoint accepts **any** address, not just your own — which is what makes
 * mirroring an exit possible at all.
 *
 * 🚩 Read **`current_size`**, never `total_size`. The second is lifetime shares
 * bought, so a trader who sold out would still look fully invested and their
 * exit would never be mirrored.
 */
export function parseTraderPositionSizes(payload: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  const rows = rowsOf(payload);
  if (!rows) return sizes;

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const tokenId = str(row.token_id);
    if (!tokenId) continue;

    const size = num(row.current_size);
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

  const payload = await dataApiFetch<unknown>(`/v2/trades?${query.toString()}`, options.signal);
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

  const payload = await dataApiFetch<unknown>(`/v2/positions?${query.toString()}`, options.signal);
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
