import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { POLYMARKET_ENDPOINTS } from "./config";

/**
 * CLOB historical prices — the line behind the featured hero.
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
 * minutes.
 *
 * ⚠️ This is history, not a quote. Nothing here may feed an order: the price
 * you can actually trade at comes from the order-book WebSocket
 * (`market-data.ts`). That distinction is why caching it below is safe when
 * caching a live price would be a correctness bug.
 *
 * Never called from the browser, same rule as `gamma.ts` — it would leak our
 * traffic shape and lose the edge cache.
 */

export type PricePoint = { t: number; p: number };

/** Windows the CLOB accepts. `1w` is what the hero uses. */
export type PriceInterval = "1h" | "6h" | "1d" | "1w" | "1m" | "max";

export type PriceHistoryParams = {
  tokenId: string;
  interval?: PriceInterval;
  /** Minutes between points. 60 over a week gives ~169 points — plenty for a sparkline. */
  fidelity?: number;
};

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Fetches a price series. **Returns `[]` instead of throwing.**
 *
 * The chart is decorative — it sits beside the real content, not in place of
 * it. A CLOB blip should cost the hero its line, not take down the home page,
 * and the caller renders the slide without a chart when the series is empty.
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
 * Cached series. Longer-lived than the ~60s Gamma policy on purpose: a week of
 * hourly history barely moves minute to minute, and the newest point is
 * already up to `fidelity` minutes old by construction.
 */
export async function getCachedPriceHistory(params: PriceHistoryParams): Promise<PricePoint[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag("clob:price-history");

  return fetchPriceHistory(params);
}

/** Keeps only well-formed `{t, p}` pairs — the shape is unvalidated wire data. */
function normalizeHistory(history: unknown): PricePoint[] {
  if (!Array.isArray(history)) return [];

  const points: PricePoint[] = [];
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null) continue;
    const { t, p } = entry as { t?: unknown; p?: unknown };
    if (typeof t !== "number" || typeof p !== "number") continue;
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    points.push({ t, p });
  }
  return points;
}

export type PriceRange = { min: number; max: number; first: number; last: number };

/** Min/max for the axis labels, first/last for the change over the window. */
export function priceRange(points: PricePoint[]): PriceRange {
  if (points.length === 0) return { min: 0, max: 0, first: 0, last: 0 };

  let min = points[0].p;
  let max = points[0].p;
  for (const point of points) {
    if (point.p < min) min = point.p;
    if (point.p > max) max = point.p;
  }
  return { min, max, first: points[0].p, last: points[points.length - 1].p };
}

export type SparklineOptions = {
  /** Room reserved top and bottom so a thick stroke isn't clipped. */
  inset?: number;
  /**
   * Vertical scale to plot against. Defaults to the series' own min/max.
   *
   * Pass an explicit domain to put several series on **one** axis: without it
   * each line is normalised to its own range, so a 77% outcome and a 24% one
   * come out as identical shapes and the chart implies a comparison it isn't
   * making.
   */
  domain?: { min: number; max: number };
};

/**
 * Maps a series to an SVG path in a `width` × `height` box.
 *
 * Scaled to the series' own min/max by default, so a market that only ever
 * moved between 16% and 19% still shows its shape instead of a flat line near
 * the floor.
 *
 * Pure — the hero renders this server-side and ships the resulting string, not
 * 169 points per slide, to the browser.
 */
export function toSparklinePath(
  points: PricePoint[],
  width: number,
  height: number,
  options: SparklineOptions = {},
): string {
  if (points.length === 0) return "";

  const inset = options.inset ?? 0;
  const { min, max } = options.domain ?? priceRange(points);
  const span = max - min;
  const usable = height - inset * 2;

  // A perfectly flat series (or a zero-width domain) has nothing to scale
  // against — centre it rather than dividing by zero.
  const y = (price: number) =>
    span === 0 ? inset + usable / 2 : inset + (1 - (price - min) / span) * usable;
  const x = (index: number) =>
    points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${round(x(index))},${round(y(point.p))}`)
    .join(" ");
}

/** Two decimals is well under sub-pixel — trims a lot of bytes off the markup. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
