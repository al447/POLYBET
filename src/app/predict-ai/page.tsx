import { Suspense } from "react";
import type { Metadata } from "next";

import { FixtureBoard, FixtureBoardSkeleton } from "@/components/predict/fixture-board";
import { PredictHero } from "@/components/predict/predict-hero";
import { withBudget } from "@/lib/budget";
import { getCachedFixtures } from "@/lib/polymarket/fixtures";
import { leaguesOf } from "@/lib/polymarket/fixtures-types";

/**
 * Predict AI — upcoming football fixtures (FR-7.1).
 *
 * The page behind the previously-inert "Predict AI" row in the nav menu and the
 * disabled "Predict Sports" button in the right sidebar.
 *
 * 🚩 The **model does not exist**. What ships here is the fixture board and the
 * market's own prices for each result; the Predict AI column is empty and says
 * so on every row. FR-7's model, provider, data sources and inference budget are
 * all still unspecified (srs.md §FR-7), so building the list against real Gamma
 * data was the half that could be done honestly. Do not fill that column with
 * market-derived numbers — a market price relabelled as a forecast is the one
 * change here that would actively mislead.
 *
 * Server-rendered fetch, client-side filtering: `getCachedFixtures` pulls the
 * whole window once and `FixtureBoard` narrows it in memory, so there is no
 * `/api/fixtures` route and nothing hits the network after first paint. Same
 * reasoning as `/leaderboard`.
 */

export const metadata: Metadata = {
  title: "Predict AI",
  description:
    "Upcoming football matches with what the market is pricing for each result.",
};

/**
 * Hard ceiling on the fixture fetch. Rationale for bounding the whole operation
 * rather than its parts is on `withBudget` in `lib/budget.ts`.
 *
 * 🚩 Why this page needs one at all. `getCachedFixtures` is the most expensive
 * cached entry on the site — up to twelve *sequential* Gamma pages under its own
 * `FIXTURES_BUDGET_MS`, ~16s worst case. And nothing refreshes it in the
 * background: OpenNext's `queue` defaults to `"dummy"`, whose `send()` throws
 * outright, so `revalidateIfRequired` logs "Failed to revalidate stale page
 * /predict-ai" and gives up. An entry therefore goes fresh -> stale -> expired
 * and the next visitor pays the whole rebuild inline. On a low-traffic route the
 * gap between visits routinely exceeds the cache lifetime, so that visitor is a
 * large share of them.
 *
 * 8s is 4x a healthy render (0.2-1.9s measured warm on the deployed Worker
 * 2026-08-23) and far under the ~100s edge timeout.
 *
 * ⚠️ Unlike the homepage case in Trap 9 of improvement.md, a `setTimeout` ceiling
 * is trustworthy here: this path *waits* on Gamma (CPU measured at 9-18ms), it
 * does not burn CPU, so the timer is not queued behind the work it bounds.
 */
const FIXTURES_PAGE_BUDGET_MS = 8000;

export default function PredictAiPage() {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-12">
      <Suspense
        fallback={
          <>
            <PredictHero />
            <div className="mt-8">
              <FixtureBoardSkeleton />
            </div>
          </>
        }
      >
        <Board />
      </Suspense>
    </div>
  );
}

async function Board() {
  // Raced directly, with no `.then()` boxing: `getCachedFixtures` returns a
  // discriminated union and never resolves to `null`, so the outer `null` can
  // only ever mean "out of time". (`/market/[slug]` does need that wrapper —
  // there `null` already meant "no such market".)
  const result = await withBudget(getCachedFixtures(), FIXTURES_PAGE_BUDGET_MS);

  // Three distinct outcomes, deliberately: we ran out of time (here), Gamma
  // answered with an error (below), or the window genuinely holds no matches.
  // Collapsing them is how a slow rebuild starts reading as a broken feature.
  if (result === null) {
    return (
      <>
        <PredictHero />
        <p className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
          Fixtures are taking longer than usual to load. Refresh to try again.
        </p>
      </>
    );
  }

  if (!result.ok) {
    return (
      <>
        <PredictHero />
        <p className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
          Fixtures are unavailable right now ({result.error}). Try again shortly.
        </p>
      </>
    );
  }

  const { fixtures } = result;

  return (
    <>
      <PredictHero matchCount={fixtures.length} leagueCount={leaguesOf(fixtures).length} />
      <div className="mt-8">
        {fixtures.length === 0 ? (
          <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
            No football fixtures are scheduled in the next few days.
          </p>
        ) : (
          <FixtureBoard fixtures={fixtures} />
        )}
      </div>
    </>
  );
}
