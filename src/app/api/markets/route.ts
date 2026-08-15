import { NextResponse } from "next/server";

import { getCachedEvents } from "@/lib/polymarket/gamma";
import type { ListEventsParams } from "@/lib/polymarket/gamma";
import {
  ENDING_FILTERS,
  EVENT_SORTS,
  LIQUIDITY_FILTERS,
  VOLUME_FILTERS,
  endingBefore,
  isEndingFilterId,
  isEventSortId,
  isLiquidityFilterId,
  isVolumeFilterId,
  resolveEndingFilter,
  resolveLiquidityFilter,
  resolveSort,
  resolveVolumeFilter,
} from "@/lib/polymarket/gamma-types";

/**
 * Gamma event-list proxy (FR-2.1, FR-2.2, FR-2.5, NFR-5).
 *
 * The browser must never call Gamma directly (implementation.md Step 2.2) —
 * this route is the only path in, so Gamma always sees our traffic shape
 * (not each visitor's) and repeat requests can be served from cache instead
 * of spending the 250 req/min budget. Used by the discovery grid client
 * component for pagination/filtering; the initial SSR paint calls
 * `getCachedEvents` directly (same cache entry, same policy, no self-fetch
 * round trip).
 *
 * `getCachedEvents` (in gamma.ts) opts into Next's Data Cache with
 * `"use cache"`; nothing else in this app does (`cacheComponents: false`, see
 * next.config.ts) — this is a deliberate, narrow exception, verified working
 * end-to-end on 2026-08-07 (identical `generatedAt` on rapid repeat calls,
 * fresh after the 60s revalidate window).
 *
 * Never cache anything beyond this list view's snapshot: `outcomePrices` here
 * is good enough for a discovery grid, not for placing an order — the trading
 * ticket reads live prices from the CLOB order-book WebSocket (Milestone 3),
 * which is never cached.
 */

const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;

  const limit = parsePositiveInt(search.get("limit"), 1, MAX_LIMIT);
  if (limit === "invalid") {
    return NextResponse.json({ error: "limit must be a positive number" }, { status: 400 });
  }

  const tagId = parsePositiveInt(search.get("tagId"), 0, Number.MAX_SAFE_INTEGER);
  if (tagId === "invalid") {
    return NextResponse.json({ error: "tagId must be a number" }, { status: 400 });
  }

  const cursor = search.get("cursor") ?? undefined;

  // Sorts arrive as an id from `EVENT_SORTS`, not a raw `order`/`ascending`
  // pair, so the two can never be split apart into a combination we haven't
  // verified. Reject an unknown id rather than silently falling back: a
  // caller asking for a sort that doesn't exist has a bug, and quietly
  // serving them "Top" would hide it.
  const sortId = search.get("sort");
  if (sortId !== null && !isEventSortId(sortId)) {
    return NextResponse.json({ error: `sort must be one of: ${sortIds()}` }, { status: 400 });
  }
  const sort = resolveSort(sortId);

  // Range filters follow the same id-not-raw-value rule as sort, for a second
  // reason on top of validation: they land in the `getCachedEvents` key, and a
  // free-form `volume_min` would give practically every request its own cache
  // entry. A closed preset set keeps the key space at a handful of values.
  const filterError = firstInvalidFilter(search);
  if (filterError) {
    return NextResponse.json({ error: filterError }, { status: 400 });
  }

  const volume = resolveVolumeFilter(search.get("volume"));
  const liquidity = resolveLiquidityFilter(search.get("liquidity"));
  const ending = resolveEndingFilter(search.get("ending"));

  const params: ListEventsParams = {
    cursor,
    limit,
    tagId,
    // Gamma's `active` means "the event page still exists," NOT "still
    // tradeable" — resolved events from years ago stay active:true forever.
    // `closed:false` is what actually excludes dead/resolved markets.
    // Discovered 2026-08-07 via manual testing: without these two defaults,
    // the endpoint returned 2021-2022 NBA/NFL bets nobody can trade anymore.
    active: parseBoolean(search.get("active")) ?? true,
    closed: parseBoolean(search.get("closed")) ?? false,
    featured: parseBoolean(search.get("featured")),
    // 🚩 `order`/`ascending` must be sent on EVERY page, cursor or not.
    //
    // A keyset cursor is bound to the sort it was generated under, and Gamma
    // 422s if you replay it under a different one — including "no sort at
    // all". Re-probed live 2026-08-15: `order=volume` + `after_cursor` is a
    // clean 200 when the order is repeated, and a 422 when it's dropped.
    //
    // This corrects the reading recorded here on 2026-08-07, which had it
    // backwards ("volume sort doesn't support pagination, so drop it once
    // paginating") and made every "Load more" 422 — page 1 sorted by volume,
    // page 2 asked the same cursor for an unsorted page. Do not reintroduce a
    // `cursor ? undefined : …` conditional on either field.
    order: sort.order,
    ascending: sort.ascending,
    volumeMin: volume.min,
    liquidityMin: liquidity.min,
    // Quantised to a day boundary inside `endingBefore` so this stays a stable
    // cache key for the whole day rather than changing every millisecond.
    endDateMax: ending.days === undefined ? undefined : endingBefore(ending.days),
  };

  const result = await getCachedEvents(params);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 502 });
  }

  return NextResponse.json({
    generatedAt: result.generatedAt,
    items: result.items,
    nextCursor: result.nextCursor,
  });
}

function sortIds(): string {
  return EVENT_SORTS.map((sort) => sort.id).join(", ");
}

/** Returns an error message for the first bad filter param, or null if all are fine. */
function firstInvalidFilter(search: URLSearchParams): string | null {
  const checks = [
    { param: "volume", isValid: isVolumeFilterId, options: VOLUME_FILTERS },
    { param: "liquidity", isValid: isLiquidityFilterId, options: LIQUIDITY_FILTERS },
    { param: "ending", isValid: isEndingFilterId, options: ENDING_FILTERS },
  ];

  for (const { param, isValid, options } of checks) {
    const value = search.get(param);
    if (value !== null && !isValid(value)) {
      return `${param} must be one of: ${options.map((option) => option.id).join(", ")}`;
    }
  }

  return null;
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Returns `undefined` when absent, a clamped int when valid, `"invalid"` when malformed. */
function parsePositiveInt(value: string | null, min: number, max: number): number | undefined | "invalid" {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "invalid";
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
