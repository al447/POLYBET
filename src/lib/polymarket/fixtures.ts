import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { listMarkets } from "./gamma";
import { GammaApiError, endingAfter, endingBefore } from "./gamma-types";
import type { GammaMarket } from "./gamma-types";
import {
  FIXTURE_WINDOW_DAYS,
  MAIN_LEAGUES,
  MONEYLINE,
  matchEventsFromMarkets,
  parseFixture,
  sortFixtures,
} from "./fixtures-types";
import type { Fixture, MainLeague } from "./fixtures-types";

/**
 * Upcoming football fixtures for the Predict AI page (FR-7.1).
 *
 * Server-only, same split as `gamma.ts` and `leaderboard.ts` — the shapes and
 * presets the browser needs live in `fixtures-types.ts`.
 *
 * ⚠️ Nothing here may inform an order. These are browse-by snapshots of the
 * match-result markets, cached for minutes at a time; the order ticket reads
 * live order-book data through its own path.
 *
 * There is deliberately **no `/api/fixtures` route**. The page server-renders
 * the whole window and hands it to a client board that filters in memory, so
 * nothing after first paint needs the network — same reason `/leaderboard`
 * needs no proxy route.
 *
 * 🚩 Reads moneyline *markets* per league, never soccer *events*. Changed
 * 2026-11-20: walking `/events/keyset` for the Soccer tag had grown to 1200+
 * events at ~11 MB of JSON per page (19s and ~135 MB per fill, past both the
 * page budget and the Worker's memory), because every match drags six prop
 * events along. The moneyline query returns only the three result legs, about
 * 300 KB per league per week.
 */

/** A busy week is ~18 matches (54 legs), so one page almost always covers a league. */
const MAX_PAGES_PER_LEAGUE = 3;

const PAGE_LIMIT = 100;

/**
 * Ceiling on each league's pagination loop. Leagues run in parallel, so this
 * is also roughly the ceiling on the whole fill. The deadline is checked
 * between pages, so one in-flight call can overrun it by up to 6s.
 */
const FIXTURES_BUDGET_MS = 10_000;

async function fetchLeagueMarkets(
  league: MainLeague,
  endDateMin: string,
  endDateMax: string,
  deadline: number,
): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES_PER_LEAGUE; page += 1) {
    if (Date.now() >= deadline) break;

    const result = await listMarkets({
      cursor: cursor ?? undefined,
      limit: PAGE_LIMIT,
      tagId: league.tagId,
      closed: false,
      sportsMarketTypes: MONEYLINE,
      endDateMin,
      endDateMax,
    });

    markets.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor || result.items.length === 0) break;
  }

  return markets;
}

/**
 * Every main-league fixture kicking off inside the window, soonest first.
 *
 * One failing league costs only its own rows. Only when every league fails
 * does this throw, so the page says "unavailable" instead of "no matches".
 *
 * The window bounds come from `endingAfter` / `endingBefore` rather than raw
 * timestamps so they quantise to the hour and the UTC day — every request in
 * the same hour shares one cache key instead of minting its own.
 */
export async function fetchFixtures(): Promise<Fixture[]> {
  const endDateMin = endingAfter();
  const endDateMax = endingBefore(FIXTURE_WINDOW_DAYS);
  const deadline = Date.now() + FIXTURES_BUDGET_MS;

  const results = await Promise.allSettled(
    MAIN_LEAGUES.map((league) => fetchLeagueMarkets(league, endDateMin, endDateMax, deadline)),
  );

  const fixtures: Fixture[] = [];
  const seen = new Set<string>();
  let firstError: unknown = null;

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      firstError ??= result.reason;
      return;
    }

    for (const event of matchEventsFromMarkets(result.value, MAIN_LEAGUES[index])) {
      const fixture = parseFixture(event);
      // `parseFixture` returns null on anything malformed, so one bad event
      // costs one row rather than the whole board.
      if (!fixture || seen.has(fixture.slug)) continue;

      seen.add(fixture.slug);
      fixtures.push(fixture);
    }
  });

  if (firstError !== null && results.every((result) => result.status === "rejected")) {
    throw firstError;
  }

  return sortFixtures(fixtures, "kickoff");
}

export type CachedFixturesResult =
  | { ok: true; generatedAt: string; fixtures: Fixture[] }
  | { ok: false; error: string };

/**
 * The cached fixture board.
 *
 * Errors are returned as data, never thrown across the cache boundary: an
 * `Error` thrown inside a `"use cache"` function reaches the caller with
 * `environmentName: 'Cache'` attached and no longer passes `instanceof`, so a
 * caller's `catch` misses it and it surfaces as an unhandled 500. Same
 * reasoning, and the same shape, as `getCachedEvents` in gamma.ts.
 *
 * Unlike `getCachedEvents` this swallows non-`GammaApiError` failures too. This
 * one call fans out to a request per league and then parses a few hundred
 * markets; a single unexpected shape anywhere in that should cost the page its
 * fixture list, not the whole render.
 *
 * The slow-moving-aggregate cache tier (60/300/3600), not the 30/60/300 that
 * price-derived listings use: kickoff times and league names do not move, and
 * the per-league fan-out makes a short window wasteful.
 *
 * 🚩 `expire` was 900 and is deliberately an hour. Nothing refreshes this entry
 * in the background — OpenNext's `queue` defaults to `"dummy"`, whose `send()`
 * throws, so `revalidateIfRequired` logs "Failed to revalidate stale page
 * /predict-ai" and stops. Past `expire` the entry is gone and the next visitor
 * pays the full fan-out *inline*; inside it, a stale board is served
 * without blocking. Widening the window is therefore the difference between an
 * idle route falling off that cliff every 15 minutes and every hour. Measured
 * 2026-08-23: site traffic was ~167 requests / 30 min, so gaps between visits to
 * a minor route routinely exceeded the old 900s and most of its visits were cold
 * rebuilds.
 *
 * ⚠️ The cost is a board up to an hour old. Acceptable *here* only because of the
 * warning at the top of this file — these are browse-by snapshots that may never
 * inform an order. Do not copy this tier onto a price-derived route.
 */
export async function getCachedFixtures(): Promise<CachedFixturesResult> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag("gamma:fixtures");

  try {
    return { ok: true, generatedAt: new Date().toISOString(), fixtures: await fetchFixtures() };
  } catch (error) {
    // shortest cacheLife wins, so a failure is retried in a minute, not an hour
    cacheLife({ stale: 30, revalidate: 30, expire: 60 });
    if (error instanceof GammaApiError) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}
