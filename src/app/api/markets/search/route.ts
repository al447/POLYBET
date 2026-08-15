import { NextResponse } from "next/server";

import { getCachedSearch } from "@/lib/polymarket/gamma";
import { SEARCH_MAX_LIMIT, SEARCH_PAGE_SIZE, isLiveEvent } from "@/lib/polymarket/gamma-types";

/**
 * Gamma full-catalogue search proxy (FR-2.4).
 *
 * Separate from `/api/markets` rather than a `q` param on it, because the two
 * are different endpoints with genuinely different contracts — `/public-search`
 * paginates by page number, not cursor, and ignores every sort and range
 * filter. Folding them together would mean one route returning two shapes.
 *
 * Same rule as the listing proxy: the browser never calls Gamma directly.
 */

const MAX_QUERY_LENGTH = 128;
const MAX_PAGE = 100;

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;

  const query = (search.get("q") ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `q must be ${MAX_QUERY_LENGTH} characters or fewer` },
      { status: 400 },
    );
  }

  // Capped rather than unbounded: `page` lands in the cache key, and an
  // arbitrary page number is a cheap way to fill it with misses.
  const page = parsePage(search.get("page"));
  if (page === "invalid") {
    return NextResponse.json({ error: `page must be between 1 and ${MAX_PAGE}` }, { status: 400 });
  }

  const result = await getCachedSearch({
    // Lower-cased so trivial variants of the same search share a cache entry.
    query: query.toLowerCase(),
    page,
    limit: Math.min(SEARCH_PAGE_SIZE, SEARCH_MAX_LIMIT),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 502 });
  }

  // 🚩 Drop already-ended markets here, not upstream: `/public-search` ignores
  // `end_date_min` exactly as it ignores every other filter, and
  // `events_status=active` only excludes *closed* events — measured 2026-08-15,
  // roughly 1 result in 20 comes back with an end date already in the past
  // while still flagged open.
  //
  // Deliberately outside `getCachedSearch`: the predicate reads the clock, and
  // doing it inside a `"use cache"` function would freeze "now" into the cache
  // entry for its whole lifetime.
  const items = result.items.filter((event) => isLiveEvent(event));

  return NextResponse.json({
    generatedAt: result.generatedAt,
    items,
    page: result.page,
    hasMore: result.hasMore,
    // Gamma's own count, before the filter above — it counts what the upstream
    // query matched, so it can read slightly high. Treated as the approximate
    // "about N results" it is, rather than a promise about `items.length`.
    totalResults: result.totalResults,
  });
}

function parsePage(value: string | null): number | "invalid" {
  if (value === null) return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "invalid";
  const page = Math.trunc(parsed);
  if (page < 1 || page > MAX_PAGE) return "invalid";
  return page;
}
