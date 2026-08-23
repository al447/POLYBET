import { withBudget } from "@/lib/budget";
import { getCachedEvents } from "@/lib/polymarket/gamma";
import { DEFAULT_SORT_ID, endingAfter, resolveSort } from "@/lib/polymarket/gamma-types";
import { MarketGrid } from "@/components/markets/market-grid";

/**
 * 🚩 Hard ceiling on the server-side first page. Do not remove it.
 *
 * Until 2026-08-23 this component's await had no bound, and it was the last
 * one on the home page that didn't — `FeaturedHero` got its ceiling the day
 * before. It is what took `/` down: 18 of 20 requests never completed, because
 * this boundary never resolved and the streamed response could not close.
 *
 * Note the call below owns a cache key nothing else warms. `/api/markets`
 * always sends `active`, `closed` and `endDateMin`; this sends none of them,
 * so the two never share an entry. That is why the API route stayed healthy at
 * 1.17 MB in 3.29s while this page hung — they were never reading the same
 * thing.
 *
 * 8s is well past a healthy render and far under the ~100s edge timeout.
 */
const DISCOVERY_BUDGET_MS = 8000;

/**
 * Server-side entry point for the discovery grid (FR-2.1, FR-2.5).
 *
 * Calls the same cached function `/api/markets` uses, directly — a Server
 * Component fetching Gamma data itself is fine (the "never call Gamma from
 * the browser" rule is about client-side fetches); this just avoids an
 * unnecessary self-HTTP round trip for the first paint. `MarketGrid` takes it
 * from there client-side for pagination/filtering.
 *
 * Renders the *unfiltered* first page regardless of the URL. When the user
 * lands on `/?tagId=…`, `MarketGrid` notices the mismatch and refetches once
 * client-side; reading `searchParams` here and server-rendering the matching
 * page would remove that round trip, and is the obvious next improvement.
 *
 * Three outcomes, and they are deliberately distinct: a page of events, an
 * error box when Gamma failed, or — past the budget above — a grid that loads
 * itself client-side.
 */
export async function DiscoverySection() {
  // Must sort by the same default `MarketGrid` starts on. The cursor this
  // returns is bound to whatever sort produced it, so an unsorted first page
  // here would 422 the grid's very first "Load more" the moment it asked for
  // page 2 under "Top". Keep these two in step.
  const sort = resolveSort(DEFAULT_SORT_ID);
  const page = await withBudget(
    getCachedEvents({
      limit: 24,
      order: sort.order,
      ascending: sort.ascending,
      // 🚩 These three are `/api/markets`'s own defaults, and passing them is
      // load-bearing for three separate reasons. Added 2026-08-23; omitting
      // them was a single bug with three faces.
      //
      // 1. **Correctness.** Measured on the unfiltered query that ran here
      //    until today: **21 of 24 events came back `closed: true`, 17 already
      //    ended.** `closed: false` alone is not enough either — Gamma leaves
      //    expired events flagged open indefinitely, which is why `endDateMin`
      //    is here too. Nobody noticed because `MarketGrid` refetches with the
      //    filters and paints over the first render.
      // 2. **Cache warmth.** Without them this owned a key nothing else ever
      //    warmed, so it went stale every revalidate window and each visitor
      //    paid the rebuild inline. It now shares the entry `/api/markets`
      //    keeps warm.
      // 3. **The cursor below.** A keyset cursor is bound to the query that
      //    produced it. `MarketGrid` paginates through `/api/markets`, which
      //    sends these three — so a cursor minted without them was being
      //    replayed under a different query.
      active: true,
      closed: false,
      // Computed out here, never inside the cached function — `"use cache"`
      // would freeze "now" into the entry. Quantised to the hour by
      // `endingAfter`, so the key stays stable rather than changing per ms.
      endDateMin: endingAfter(),
    }),
    DISCOVERY_BUDGET_MS,
  );

  // Out of time. Hand the grid `null` — distinct from `[]`, which would mean
  // Gamma genuinely returned nothing — and it fetches `/api/markets` itself on
  // mount. That path is the one "Load more" and the category chips already use
  // every day, and it is measurably healthy, so the cost of a slow render is
  // the grid's first paint rather than the whole page.
  if (page === null) return <MarketGrid initialEvents={null} initialCursor={null} />;

  if (!page.ok) {
    return (
      <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-6 text-center text-sm text-red-300">
        Couldn&apos;t load markets right now ({page.error}). Try refreshing.
      </p>
    );
  }

  return <MarketGrid initialEvents={page.items} initialCursor={page.nextCursor} />;
}

export function DiscoverySectionSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-40 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
      ))}
    </div>
  );
}
