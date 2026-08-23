import { getCachedEventComments, getCachedEvents } from "@/lib/polymarket/gamma";
import { endingAfter, rankEventOutcomes } from "@/lib/polymarket/gamma-types";
import type { GammaEvent, RankedOutcome } from "@/lib/polymarket/gamma-types";
import { getCachedPriceHistory, priceRange, toSparklinePath } from "@/lib/polymarket/price-history";
import type { PricePoint } from "@/lib/polymarket/price-history";
import { formatEndDate, formatRelativeTime, formatUsd } from "@/lib/format";
import { FeaturedHeroCarousel } from "@/components/markets/featured-hero-carousel";
import type { HeroChartSeries, HeroSlide } from "@/components/markets/featured-hero-carousel";

/**
 * Featured markets hero — the home page's opening panel.
 *
 * Everything the carousel renders is resolved here, server-side: the event
 * list from Gamma, a week of price history per charted outcome from the CLOB,
 * and the newest comment. The client gets formatted strings and a finished SVG
 * path, never raw series.
 *
 * Three requests per slide (two charts and a comment fetch) sounds heavy, but
 * all of them are `"use cache"`-backed and issued in one parallel burst, so a
 * warm render does no network work at all.
 *
 * Returns `null` on any failure — including a partial one. The hero is the
 * top of a page whose actual job is the market grid below it; degrading to
 * "no hero" is always better than degrading to "no home page".
 */

/** Slides in the carousel. Each costs 3 cached upstream calls on a cold render. */
const SLIDE_COUNT = 5;
/** Outcomes listed on the left. */
const OUTCOME_ROWS = 3;
/** Outcomes given a line on the chart. Two reads clearly; three is spaghetti. */
const CHARTED_SERIES = 2;
/** Leader first, so the colours are stable across slides. */
const SERIES_COLORS = ["text-emerald-400", "text-sky-400"];
/** Reserves room so a 2px stroke isn't clipped at the extremes. */
const CHART_INSET = 6;
/** SVG user units the paths are generated in; the carousel scales to fit. */
const CHART_WIDTH = 640;
const CHART_HEIGHT = 190;

/**
 * 🚩 Hard ceiling on the whole hero. Do not remove without replacing it.
 *
 * The docstring above promises the hero degrades to nothing rather than taking
 * the page down with it — but before 2026-08-23 that only held for *errors*.
 * On slowness it waited indefinitely, and the homepage waited with it.
 *
 * Measured on the deployed Worker that day, after the Gamma budget and the WAF
 * block were both already live: 6 homepage requests returned
 * `4.85 3.18 2.07 1.81 1.83` seconds — and then **120s**, which was only that
 * round because the probe gave up there. In production that is a 504.
 *
 * Note what this is NOT. Every upstream call here is already capped at 6s
 * (`gammaFetch`, `price-history.ts`), and Gamma answers in ~110ms when probed
 * directly, so the fetches are not what runs long. A cold render fans out 16
 * `"use cache"` entries — 1 event list + 5 slides x (2 price histories + 1
 * comments) — and each is a separate R2 read and write, with no `queue`
 * configured so revalidation happens inside the request. The cache layer is
 * the thing without a bound, and it is not one this component can fix.
 *
 * So the ceiling is deliberately on the *whole* operation rather than its
 * parts: it holds no matter which layer misbehaves. 8s is well past a healthy
 * cold render and far under the ~100s edge timeout.
 */
const HERO_BUDGET_MS = 8000;

export async function FeaturedHero() {
  // `Promise.race` leaves the slow branch running — that is intended. Its cache
  // writes still land, so the render that times out warms the entry for the
  // next visitor instead of wasting the work.
  const slides = await Promise.race([
    buildSlides(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HERO_BUDGET_MS)),
  ]);

  if (!slides || slides.length === 0) return null;

  return <FeaturedHeroCarousel slides={slides} />;
}

async function buildSlides(): Promise<HeroSlide[] | null> {
  const page = await getCachedEvents({
    featured: true,
    active: true,
    closed: false,
    order: "volume24hr",
    ascending: false,
    limit: SLIDE_COUNT,
    // Same guard the browse feed uses: `closed: false` does NOT mean "still
    // tradeable" — Gamma leaves expired events flagged open indefinitely, and
    // a resolved market at the top of the home page would be a bad first
    // impression. Computed out here, not inside the cached function, or "now"
    // would be frozen into the cache entry.
    endDateMin: endingAfter(),
  });

  if (!page.ok || page.items.length === 0) return null;

  return (await Promise.all(page.items.map(buildSlide))).filter(
    (slide): slide is HeroSlide => slide !== null,
  );
}

async function buildSlide(event: GammaEvent): Promise<HeroSlide | null> {
  const ranked = rankEventOutcomes(event);
  if (ranked.length === 0) return null;

  // Type predicate rather than a cast: only outcomes with a CLOB token can be
  // charted, and the narrowing should be the compiler's job, not a promise.
  const charted = ranked
    .filter((outcome): outcome is RankedOutcome & { tokenId: string } => outcome.tokenId !== null)
    .slice(0, CHARTED_SERIES);

  const [histories, comments] = await Promise.all([
    Promise.all(
      charted.map((outcome) =>
        getCachedPriceHistory({ tokenId: outcome.tokenId, interval: "1w", fidelity: 60 }),
      ),
    ),
    getCachedEventComments(event.id, 1),
  ]);

  const comment = comments[0];
  const profile = comment?.profile;

  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    icon: event.icon ?? event.image,
    categories: (event.tags ?? [])
      .slice(0, 2)
      .map((tag) => tag.label ?? tag.slug ?? "")
      .filter(Boolean),
    outcomes: ranked.slice(0, OUTCOME_ROWS).map(({ label, pct }) => ({ label, pct })),
    chart: buildChart(
      charted.map((outcome, index) => ({ label: outcome.label, points: histories[index] })),
    ),
    comment: comment
      ? {
          name: profile?.name ?? profile?.pseudonym ?? "Anonymous",
          body: comment.body,
          ago: formatRelativeTime(comment.createdAt),
          avatar: profile?.profileImage,
        }
      : null,
    volume: formatUsd(event.volume),
    ends: `Ends ${formatEndDate(event.endDate)}`,
  };
}

/**
 * Renders every series against **one shared domain**.
 *
 * Letting each line normalise to its own min/max would draw a 77% outcome and
 * a 24% one as the same shape — two very different markets looking identical.
 * The domain spans every plotted series, so the lines sit where they belong
 * relative to each other.
 */
function buildChart(series: { label: string; points: PricePoint[] }[]): HeroSlide["chart"] {
  const populated = series.filter((entry) => entry.points.length > 0);
  if (populated.length === 0) return null;

  const domain = priceRange(populated.flatMap((entry) => entry.points));

  const scaled: HeroChartSeries[] = populated.map((entry, index) => ({
    label: entry.label,
    colorClass: SERIES_COLORS[index] ?? "text-zinc-400",
    path: toSparklinePath(entry.points, CHART_WIDTH, CHART_HEIGHT, {
      inset: CHART_INSET,
      domain,
    }),
  }));

  const window = populated[0].points;

  return {
    series: scaled,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    highLabel: `${Math.round(domain.max * 100)}%`,
    lowLabel: `${Math.round(domain.min * 100)}%`,
    startLabel: formatDay(window[0].t),
    endLabel: formatDay(window[window.length - 1].t),
  };
}

function formatDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function FeaturedHeroSkeleton() {
  return <div className="h-80 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/40" />;
}
