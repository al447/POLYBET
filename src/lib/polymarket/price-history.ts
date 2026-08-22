import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { POLYMARKET_ENDPOINTS } from "./config";
import { normalizeHistory, resolvePriceRange } from "./price-history-types";
import type { PricePoint, PriceInterval, PriceRangeId } from "./price-history-types";

/**
 * CLOB historical prices — the market detail chart and the featured hero line.
 *
 * Verified live 2026-08-16:
 *
 * ```
 * GET https://clob.polymarket.com/prices-history?market=<tokenId>&interval=1w&fidelity=60
 * → {"history":[{"t":1786258812,"p":0.1815}, …]}   // 169 points over 7 days
 * ```
 *
 * `market` is a **CLOB token id** (one side of one market), not a condition id
 * or a slug — so a two-outcome market has two separate series. `t` is Unix
 * seconds, `p` is the 0-1 price. `fidelity` is the gap between points in
 * minutes, and must be paired with the interval — see `PRICE_RANGES`.
 *
 * ⚠️ This is history, not a quote. Nothing here may feed an order: the price
 * you can actually trade at comes from the order-book WebSocket
 * (`market-data.ts`). That distinction is why caching it below is safe when
 * caching a live price would be a correctness bug.
 *
 * Never called from the browser, same rule as `gamma.ts` — it would leak our
 * traffic shape and lose the edge cache. The chart goes through
 * `/api/markets/price-history`. Types and chart math live in
 * `price-history-types.ts` so the client half can import them without this.
 */

export type {
  PricePoint,
  PriceInterval,
  PriceRange,
  PriceRangeId,
  PriceRangeBounds,
  SparklineOptions,
} from "./price-history-types";
export {
  DEFAULT_PRICE_RANGE_ID,
  PRICE_RANGES,
  isPriceRangeId,
  normalizeHistory,
  priceRange,
  resolvePriceRange,
  toSparklinePath,
} from "./price-history-types";

export type PriceHistoryParams = {
  tokenId: string;
  interval?: PriceInterval;
  /** Minutes between points. Must suit `interval` — see `PRICE_RANGES`. */
  fidelity?: number;
};

/**
 * 6s, matching `gammaFetch`'s whole-call budget. There are no retries here, so
 * this really is the worst case — but `getCachedRangeHistories` fans out up to
 * `MAX_SERIES` of these in parallel, and the chart renders inside a Suspense
 * boundary, so a slow CLOB stalls the page stream rather than erroring.
 * Healthy responses are well under a second.
 */
const REQUEST_TIMEOUT_MS = 6000;

/**
 * Fetches a price series. **Returns `[]` instead of throwing.**
 *
 * The chart is supporting detail — it sits beside the outcome list and the
 * order ticket, not in place of them. A CLOB blip should cost a chart its
 * line, not take down the market page, and callers render an explicit
 * "no history" state when the series is empty.
 */
export async function fetchPriceHistory(params: PriceHistoryParams): Promise<PricePoint[]> {
  const query = new URLSearchParams({
    market: params.tokenId,
    interval: params.interval ?? "1w",
    fidelity: String(params.fidelity ?? 60),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${POLYMARKET_ENDPOINTS.clob}/prices-history?${query.toString()}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );
    if (!response.ok) return [];

    const body = (await response.json()) as { history?: unknown };
    return normalizeHistory(body.history);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cached series. Longer-lived than the ~60s Gamma policy on purpose: history
 * barely moves minute to minute, and the newest point is already up to
 * `fidelity` minutes old by construction.
 */
export async function getCachedPriceHistory(params: PriceHistoryParams): Promise<PricePoint[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag("clob:price-history");

  return fetchPriceHistory(params);
}

/**
 * Fetches one series per token for a named range, in parallel.
 *
 * Takes a range **id** rather than an interval/fidelity pair, so a caller
 * cannot request a combination that returns an empty history — see the table
 * on `PRICE_RANGES`.
 */
export async function getCachedRangeHistories(
  tokenIds: string[],
  rangeId: PriceRangeId,
): Promise<PricePoint[][]> {
  const range = resolvePriceRange(rangeId);
  return Promise.all(
    tokenIds.map((tokenId) =>
      getCachedPriceHistory({ tokenId, interval: range.interval, fidelity: range.fidelity }),
    ),
  );
}
