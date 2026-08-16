/**
 * Price-history shapes, range presets and chart math.
 *
 * Deliberately **not** `server-only`, mirroring the `gamma-types.ts` /
 * `gamma.ts` split: the market chart re-renders in the browser when the user
 * switches range, so it needs the presets and `toSparklinePath` without
 * pulling in network access. The fetching half lives in `price-history.ts`.
 */

export type PricePoint = { t: number; p: number };

/** Windows the CLOB accepts. */
export type PriceInterval = "1h" | "6h" | "1d" | "1w" | "1m" | "max";

/**
 * Chart range tabs.
 *
 * 🚩 **`fidelity` is not a free parameter — it must suit the interval, or the
 * API returns an EMPTY history with a 200.** Measured live 2026-08-16 on one
 * token:
 *
 * | interval | fidelity 1 | fidelity 5 | fidelity 60 |
 * |---|---|---|---|
 * | `1h`  | 61   | 13   | 2   |
 * | `6h`  | 361  | 72   | 7   |
 * | `1d`  | 1441 | 289  | 25  |
 * | `1w`  | **0**    | 2017 | 169 |
 * | `1m`  | **0**    | **0**    | 743 |
 * | `max` | 4452 | 4452 | 743 |
 *
 * So a single fidelity across every tab silently blanks some of them: 60
 * everywhere gives a 2-point "1H" chart, 1 everywhere gives an empty "1W" and
 * "1M". The pairing below targets roughly 60-750 points — enough shape to
 * read, small enough to ship as one SVG path. They travel together as a single
 * range id for the same reason `EVENT_SORTS` pairs `order` with `ascending`:
 * a caller must not be able to combine them into a state nobody verified.
 */
export const PRICE_RANGES = [
  { id: "1h", label: "1H", interval: "1h", fidelity: 1 },
  { id: "6h", label: "6H", interval: "6h", fidelity: 5 },
  { id: "1d", label: "1D", interval: "1d", fidelity: 5 },
  { id: "1w", label: "1W", interval: "1w", fidelity: 60 },
  { id: "1m", label: "1M", interval: "1m", fidelity: 60 },
  { id: "max", label: "ALL", interval: "max", fidelity: 60 },
] as const satisfies readonly { id: string; label: string; interval: PriceInterval; fidelity: number }[];

export type PriceRange = (typeof PRICE_RANGES)[number];
export type PriceRangeId = PriceRange["id"];

/** A week reads well for most markets: enough history to show a trend, still detailed. */
export const DEFAULT_PRICE_RANGE_ID: PriceRangeId = "1w";

// Looked up by id, not by index — reordering the tabs must not silently change
// what an unrecognised value falls back to.
const DEFAULT_RANGE: PriceRange =
  PRICE_RANGES.find((range) => range.id === DEFAULT_PRICE_RANGE_ID) ?? PRICE_RANGES[0];

/** Resolves a wire value to a range, falling back to the default on anything unrecognised. */
export function resolvePriceRange(id: string | null | undefined): PriceRange {
  return PRICE_RANGES.find((range) => range.id === id) ?? DEFAULT_RANGE;
}

export function isPriceRangeId(value: string): value is PriceRangeId {
  return PRICE_RANGES.some((range) => range.id === value);
}

/** Keeps only well-formed `{t, p}` pairs — the shape is unvalidated wire data. */
export function normalizeHistory(history: unknown): PricePoint[] {
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

export type PriceRangeBounds = { min: number; max: number; first: number; last: number };

/** Min/max for the axis labels, first/last for the change over the window. */
export function priceRange(points: PricePoint[]): PriceRangeBounds {
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
  /**
   * Shared time axis, as `[startUnixSeconds, endUnixSeconds]`.
   *
   * Without it, x is spread evenly across the point *index*, which is only
   * correct when every series has the same points at the same times. Series
   * that start at different moments (a market added late) would otherwise be
   * stretched to full width and misalign with the others.
   */
  timeDomain?: { start: number; end: number };
};

/**
 * Maps a series to an SVG path in a `width` × `height` box.
 *
 * Pure — rendered once per range change and handed to the DOM as a single
 * `d` attribute rather than as hundreds of points.
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

  const time = options.timeDomain;
  const timeSpan = time ? time.end - time.start : 0;
  const x = (index: number) => {
    if (time && timeSpan > 0) return ((points[index].t - time.start) / timeSpan) * width;
    return points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
  };

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${round(x(index))},${round(y(point.p))}`)
    .join(" ");
}

/** Two decimals is well under sub-pixel — trims a lot of bytes off the markup. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
