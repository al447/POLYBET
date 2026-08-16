"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_PRICE_RANGE_ID,
  PRICE_RANGES,
  priceRange,
  toSparklinePath,
} from "@/lib/polymarket/price-history-types";
import type { PricePoint, PriceRangeId } from "@/lib/polymarket/price-history-types";

/**
 * Multi-outcome price chart for the market detail page.
 *
 * One line per outcome on a shared axis, with range tabs (1H … ALL). The
 * initial range is fetched server-side and handed in as `initialSeries`, so the
 * chart is drawn on first paint; switching range refetches through
 * `/api/markets/price-history` — never the CLOB directly.
 *
 * ⚠️ These are **historical** prices. The tradeable number is the order book's
 * (`OrderBook`, `TradingPanel`), which is deliberately never cached. Nothing
 * here should ever be wired into an order.
 */

export type ChartSeriesInput = {
  tokenId: string;
  label: string;
  /** 0-100 snapshot, shown in the legend. */
  pct: number | null;
};

const WIDTH = 900;
const HEIGHT = 320;
const INSET = 8;

/**
 * Legend/line colours, in rank order. Chosen to stay distinguishable for the
 * common forms of colour blindness — deuteranopia turns a red/green pair into
 * two browns, so the first two are blue and green rather than green and red,
 * and every line is also labelled with its own name and percentage.
 */
const SERIES_COLORS = [
  "text-blue-400",
  "text-emerald-400",
  "text-orange-400",
  "text-amber-300",
  "text-fuchsia-400",
  "text-cyan-300",
];

export function MarketChart({
  outcomes,
  initialSeries,
  initialRangeId = DEFAULT_PRICE_RANGE_ID,
}: {
  outcomes: ChartSeriesInput[];
  initialSeries: PricePoint[][];
  initialRangeId?: PriceRangeId;
}) {
  const [rangeId, setRangeId] = useState<PriceRangeId>(initialRangeId);
  const [series, setSeries] = useState<PricePoint[][]>(initialSeries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenIds = useMemo(() => outcomes.map((outcome) => outcome.tokenId), [outcomes]);
  const tokenKey = tokenIds.join(",");

  // The server already fetched `initialRangeId`; refetching it on mount would
  // be a wasted round trip on every page load.
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      if (rangeId === initialRangeId) return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/markets/price-history?tokenIds=${tokenKey}&range=${rangeId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return (await response.json()) as { series: PricePoint[][] };
      })
      .then((body) => {
        if (!cancelled) setSeries(body.series);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load price history for this range.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rangeId, tokenKey, initialRangeId]);

  const chart = useMemo(() => buildChart(series), [series]);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <ul className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        {outcomes.map((outcome, index) => (
          <li key={outcome.tokenId} className="flex items-center gap-2 text-sm">
            <span
              className={`size-2 shrink-0 rounded-full bg-current ${colorFor(index)}`}
              aria-hidden
            />
            <span className="truncate text-zinc-400">{outcome.label}</span>
            <span className="font-semibold text-zinc-100 tabular-nums">
              {outcome.pct !== null ? `${outcome.pct}%` : "—"}
            </span>
          </li>
        ))}
      </ul>

      <div className={`flex gap-3 transition-opacity ${loading ? "opacity-50" : ""}`}>
        <div className="min-w-0 flex-1">
          {chart ? (
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`Price history over ${labelFor(rangeId)} for ${outcomes
                .map((outcome) => outcome.label)
                .join(", ")}`}
              className="h-64 w-full sm:h-80"
            >
              {chart.gridlines.map((y) => (
                <line
                  key={y}
                  x1={0}
                  x2={WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="3 5"
                  className="text-zinc-800"
                />
              ))}
              {chart.paths.map((path, index) =>
                path ? (
                  <path
                    key={outcomes[index]?.tokenId ?? index}
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    // Keeps the stroke 2px after the non-uniform scaling
                    // `preserveAspectRatio="none"` applies.
                    vectorEffect="non-scaling-stroke"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className={colorFor(index)}
                  />
                ) : null,
              )}
            </svg>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-600 sm:h-80">
              {loading ? "Loading price history…" : "No price history for this range"}
            </div>
          )}

          {chart ? (
            <div className="mt-1 flex justify-between text-xs text-zinc-600">
              {chart.timeLabels.map((label, index) => (
                <span key={`${label}-${index}`}>{label}</span>
              ))}
            </div>
          ) : null}
        </div>

        {chart ? (
          <div className="flex w-10 shrink-0 flex-col justify-between py-1 text-right text-xs text-zinc-600 tabular-nums">
            {chart.axisLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-1">
        {PRICE_RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            onClick={() => setRangeId(range.id)}
            aria-pressed={range.id === rangeId}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              range.id === rangeId
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            {range.label}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function colorFor(index: number): string {
  return SERIES_COLORS[index] ?? "text-zinc-400";
}

function labelFor(id: PriceRangeId): string {
  return PRICE_RANGES.find((range) => range.id === id)?.label ?? id;
}

type BuiltChart = {
  paths: string[];
  axisLabels: string[];
  timeLabels: string[];
  gridlines: number[];
};

/**
 * Puts every series on one price axis **and** one time axis.
 *
 * Both matter. A shared price domain is what stops a 20% outcome and a 5% one
 * drawing as the same shape. A shared time domain is what keeps them aligned
 * when they have different point counts — a market added late in the window
 * has fewer points, and spreading it evenly across the width would slide its
 * whole history rightward against the others.
 */
function buildChart(series: PricePoint[][]): BuiltChart | null {
  const populated = series.filter((points) => points.length > 0);
  if (populated.length === 0) return null;

  const all = populated.flat();
  const bounds = priceRange(all);

  // Pad the price domain by 10% of its span so lines don't ride the frame,
  // then clamp to [0, 1] — a probability outside that range is meaningless.
  const pad = Math.max((bounds.max - bounds.min) * 0.1, 0.01);
  const domain = {
    min: Math.max(0, bounds.min - pad),
    max: Math.min(1, bounds.max + pad),
  };

  const times = all.map((point) => point.t);
  const timeDomain = { start: Math.min(...times), end: Math.max(...times) };

  const paths = series.map((points) =>
    points.length > 0
      ? toSparklinePath(points, WIDTH, HEIGHT, { inset: INSET, domain, timeDomain })
      : "",
  );

  // Four evenly-spaced reference prices, top to bottom.
  const steps = [0, 1, 2, 3];
  const axisLabels = steps.map(
    (step) => `${Math.round((domain.max - ((domain.max - domain.min) * step) / 3) * 100)}%`,
  );
  const gridlines = steps.map((step) => INSET + ((HEIGHT - INSET * 2) * step) / 3);

  const span = timeDomain.end - timeDomain.start;
  const timeLabels = [0, 1, 2, 3, 4].map((step) =>
    formatTick(timeDomain.start + (span * step) / 4, span),
  );

  return { paths, axisLabels, timeLabels, gridlines };
}

/**
 * Ticks show the time of day on short ranges and the date on long ones — "Aug
 * 16" repeated five times across a 6-hour window tells the reader nothing.
 */
function formatTick(unixSeconds: number, spanSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const withinADay = spanSeconds <= 60 * 60 * 24;

  return withinADay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
