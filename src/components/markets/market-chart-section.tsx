import { rankEventOutcomes } from "@/lib/polymarket/gamma-types";
import type { GammaEvent, RankedOutcome } from "@/lib/polymarket/gamma-types";
import { getCachedRangeHistories } from "@/lib/polymarket/price-history";
import { DEFAULT_PRICE_RANGE_ID } from "@/lib/polymarket/price-history-types";
import { MarketChart } from "@/components/markets/market-chart";
import type { ChartSeriesInput } from "@/components/markets/market-chart";

/**
 * Server half of the detail-page chart: picks which outcomes to plot and
 * fetches the opening range, so the chart is drawn on first paint rather than
 * appearing after a client round trip.
 *
 * Returns `null` when there is nothing to draw — a market with no CLOB tokens,
 * or a CLOB outage. The outcome list and order ticket below are the page's
 * actual job; the chart is context.
 */

/**
 * Lines on the chart. The reference tops out around five, and past that the
 * lines overlap into noise — a 128-outcome event like "Democratic Presidential
 * Nominee 2028" would be unreadable. Everything else stays in the outcome list
 * underneath, which is where the full field belongs.
 */
const MAX_SERIES = 5;

export async function MarketChartSection({ event }: { event: GammaEvent }) {
  const ranked = rankEventOutcomes(event)
    .filter((outcome): outcome is RankedOutcome & { tokenId: string } => outcome.tokenId !== null)
    .slice(0, MAX_SERIES);

  if (ranked.length === 0) return null;

  const series = await getCachedRangeHistories(
    ranked.map((outcome) => outcome.tokenId),
    DEFAULT_PRICE_RANGE_ID,
  );

  // Every series empty means the CLOB gave us nothing for any outcome —
  // render nothing rather than an empty frame with a legend above it.
  if (series.every((points) => points.length === 0)) return null;

  const outcomes: ChartSeriesInput[] = ranked.map((outcome) => ({
    tokenId: outcome.tokenId,
    label: outcome.label,
    pct: outcome.pct,
  }));

  return (
    <MarketChart
      outcomes={outcomes}
      initialSeries={series}
      initialRangeId={DEFAULT_PRICE_RANGE_ID}
    />
  );
}

export function MarketChartSkeleton() {
  return <div className="h-96 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/40" />;
}
