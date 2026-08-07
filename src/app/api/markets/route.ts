import { NextResponse } from "next/server";

import { getCachedEvents } from "@/lib/polymarket/gamma";
import type { ListEventsParams } from "@/lib/polymarket/gamma";

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
    // Default to highest-volume-first on the FIRST page only. Confirmed
    // 2026-08-07: Gamma's `/events/keyset` returns 422 for `order=volume`
    // combined with `after_cursor` — cursor pagination doesn't support a
    // volume sort. Once paginating, drop `order`/`ascending` and let Gamma's
    // own keyset default carry the rest of the pages; a caller can still
    // request an explicit order via query params if they want one.
    order: search.get("order") ?? (cursor ? undefined : "volume"),
    ascending: parseBoolean(search.get("ascending")) ?? (cursor ? undefined : false),
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
