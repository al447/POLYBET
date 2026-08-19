import { Suspense } from "react";
import type { Metadata } from "next";

import { FixtureBoard, FixtureBoardSkeleton } from "@/components/predict/fixture-board";
import { PredictHero } from "@/components/predict/predict-hero";
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
  const result = await getCachedFixtures();

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
