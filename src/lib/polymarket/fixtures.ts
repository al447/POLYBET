import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { listEvents } from "./gamma";
import { GammaApiError, endingAfter, endingBefore } from "./gamma-types";
import {
  FIXTURE_WINDOW_DAYS,
  SOCCER_TAG_ID,
  isMatchEvent,
  parseFixture,
  sortFixtures,
} from "./fixtures-types";
import type { Fixture } from "./fixtures-types";

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
 */

/**
 * How many keyset pages to walk before giving up.
 *
 * Sized from live measurement 2026-08-19: a 7-day window held 176 matches
 * spread across ~1200 events, because the six derived events per fixture
 * (Halftime Result, Exact Score, Total Corners, ...) are ~85% of the payload
 * and Gamma has no filter to exclude them. Twelve pages of 100 covers that with
 * headroom. It is a guard against paging forever if Gamma's cursor misbehaves,
 * not a target — the loop stops as soon as the cursor runs out.
 */
const MAX_PAGES = 12;

const PAGE_LIMIT = 100;

/**
 * 🚩 Ceiling on the WHOLE pagination loop, not one page.
 *
 * `MAX_PAGES` bounds how many pages we walk; it does not bound how long that
 * takes. Each `listEvents` is one `gammaFetch`, capped at `TOTAL_BUDGET_MS`
 * (6s) — so twelve sequential pages is **72 seconds** worst case, in a single
 * request, before R2, middleware or render get a turn. Cloudflare times a
 * request out at 100s.
 *
 * This is the same lesson as `gammaFetch`'s own budget one level up: bounding
 * each call is not bounding the loop that makes twelve of them. Diagnosed
 * 2026-08-23 — `/predict-ai` was the second-worst 504 path on the site.
 *
 * Slot-time is the real cost, not just this page. A request that runs 72s
 * holds a Worker isolate for 72s, and requests queued behind it time out too
 * — which is why `/api/health` and `/terms` also 504'd during the bursts.
 *
 * On expiry we return the fixtures collected so far rather than throwing: a
 * partial board is strictly better than no page. The deadline is checked
 * *between* pages, so one in-flight call can overrun it by up to 6s.
 */
const FIXTURES_BUDGET_MS = 10_000;

/**
 * Every football fixture kicking off inside the window, soonest first.
 *
 * 🚩 The keyset cursor is bound to the sort that produced it. Replaying a
 * cursor under a different sort — including *no* sort — is a 422, which is why
 * `order` and `ascending` are repeated identically on every page rather than
 * sent once on the first. See the Gamma cursor trap in CLAUDE.md; the earlier
 * version of that note had this exactly backwards and broke "Load more" in
 * production for a week.
 *
 * The window bounds come from `endingAfter` / `endingBefore` rather than raw
 * timestamps so they quantise to the hour and the UTC day — every request in
 * the same hour shares one cache key instead of minting its own.
 */
export async function fetchFixtures(): Promise<Fixture[]> {
  const endDateMin = endingAfter();
  const endDateMax = endingBefore(FIXTURE_WINDOW_DAYS);

  const fixtures: Fixture[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  // Computed once, before the loop — the same shape gammaFetch uses for its
  // own retries. See FIXTURES_BUDGET_MS.
  const deadline = Date.now() + FIXTURES_BUDGET_MS;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Out of time: hand back what we have. `sortFixtures` below still runs, so
    // a truncated board is ordered correctly rather than half-sorted.
    if (Date.now() >= deadline) break;

    const result = await listEvents({
      cursor: cursor ?? undefined,
      limit: PAGE_LIMIT,
      tagId: SOCCER_TAG_ID,
      active: true,
      closed: false,
      order: "endDate",
      ascending: true,
      endDateMin,
      endDateMax,
    });

    for (const event of result.items) {
      if (!isMatchEvent(event)) continue;

      const fixture = parseFixture(event);
      // `parseFixture` returns null on anything malformed, so one bad event
      // costs one row rather than the whole board.
      if (!fixture || seen.has(fixture.slug)) continue;

      seen.add(fixture.slug);
      fixtures.push(fixture);
    }

    cursor = result.nextCursor;
    if (!cursor || result.items.length === 0) break;
  }

  // Gamma orders by `endDate` already, but the derived events are interleaved
  // and dropped, so re-sorting here guarantees the contract the board relies on
  // regardless of what survived the filter.
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
 * one call fans out to twelve upstream requests and then parses a few hundred
 * events; a single unexpected shape anywhere in that should cost the page its
 * fixture list, not the whole render.
 *
 * The slow-moving-aggregate cache tier (60/300/900), not the 30/60/300 that
 * price-derived listings use: kickoff times and league names do not move, and
 * the twelve-request fan-out makes a short window expensive.
 */
export async function getCachedFixtures(): Promise<CachedFixturesResult> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag("gamma:fixtures");

  try {
    return { ok: true, generatedAt: new Date().toISOString(), fixtures: await fetchFixtures() };
  } catch (error) {
    if (error instanceof GammaApiError) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}
