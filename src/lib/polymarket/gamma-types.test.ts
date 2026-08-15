import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTER_ID,
  DEFAULT_SORT_ID,
  ENDING_FILTERS,
  EVENT_SORTS,
  LIQUIDITY_FILTERS,
  VOLUME_FILTERS,
  endingAfter,
  endingBefore,
  isEventSortId,
  isLiveEvent,
  isVolumeFilterId,
  resolveEndingFilter,
  resolveLiquidityFilter,
  resolveSort,
  resolveVolumeFilter,
} from "./gamma-types";

/**
 * Sort options (FR-2.2).
 *
 * The point of these is less "does find() work" and more that the
 * order/ascending pairing stays intact. Gamma binds a keyset cursor to the
 * sort that produced it, so a half-applied sort (right order, wrong
 * direction) doesn't render oddly — it 422s the next page.
 */
describe("resolveSort", () => {
  it("resolves every declared id to its own entry", () => {
    for (const sort of EVENT_SORTS) {
      expect(resolveSort(sort.id)).toBe(sort);
    }
  });

  it("falls back to the default for unknown, null and undefined ids", () => {
    const fallback = resolveSort(DEFAULT_SORT_ID);

    expect(resolveSort("nonsense")).toBe(fallback);
    expect(resolveSort(null)).toBe(fallback);
    expect(resolveSort(undefined)).toBe(fallback);
  });

  it("defaults to highest-volume-first, matching the server-rendered first page", () => {
    // DiscoverySection fetches page 1 with this pair. If they drift, the very
    // first "Load more" asks a volume-sorted cursor for a differently-sorted
    // page and Gamma 422s.
    expect(resolveSort(DEFAULT_SORT_ID)).toMatchObject({ order: "volume", ascending: false });
  });

  it("sorts only ascending where the label means 'smallest first'", () => {
    // "Ending soon" is the sole ascending sort — everything else is a
    // biggest/newest-first ranking.
    const ascending = EVENT_SORTS.filter((sort) => sort.ascending).map((sort) => sort.id);

    expect(ascending).toEqual(["ending"]);
  });

  it("declares unique ids and order values", () => {
    const ids = EVENT_SORTS.map((sort) => sort.id);
    const orders = EVENT_SORTS.map((sort) => sort.order);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("isEventSortId", () => {
  it("accepts every declared id", () => {
    for (const sort of EVENT_SORTS) {
      expect(isEventSortId(sort.id)).toBe(true);
    }
  });

  it("rejects unknown ids, including raw Gamma order values", () => {
    // `volume` is a valid Gamma `order`, but not a valid sort id — the two
    // vocabularies are deliberately separate so a caller can't send an
    // unverified order/ascending combination.
    expect(isEventSortId("volume")).toBe(false);
    expect(isEventSortId("")).toBe(false);
    expect(isEventSortId("TOP")).toBe(false);
  });
});

describe("range filters", () => {
  it("treats the default id as no filter at all", () => {
    // Every filter's no-op option must carry an undefined bound, or the
    // "Any" chip would silently narrow the grid.
    expect(resolveVolumeFilter(DEFAULT_FILTER_ID).min).toBeUndefined();
    expect(resolveLiquidityFilter(DEFAULT_FILTER_ID).min).toBeUndefined();
    expect(resolveEndingFilter(DEFAULT_FILTER_ID).days).toBeUndefined();
  });

  it("puts the no-op option first, since resolve falls back to it", () => {
    expect(VOLUME_FILTERS[0].id).toBe(DEFAULT_FILTER_ID);
    expect(LIQUIDITY_FILTERS[0].id).toBe(DEFAULT_FILTER_ID);
    expect(ENDING_FILTERS[0].id).toBe(DEFAULT_FILTER_ID);
  });

  it("resolves declared ids to their bounds", () => {
    expect(resolveVolumeFilter("1m").min).toBe(1_000_000);
    expect(resolveLiquidityFilter("50k").min).toBe(50_000);
    expect(resolveEndingFilter("30d").days).toBe(30);
  });

  it("falls back to no filter on an unknown id", () => {
    expect(resolveVolumeFilter("9000t").min).toBeUndefined();
    expect(isVolumeFilterId("9000t")).toBe(false);
  });
});

describe("endingBefore", () => {
  it("bounds to the end of the UTC day N days out", () => {
    expect(endingBefore(7, new Date("2026-08-15T13:45:12.345Z"))).toBe("2026-08-22T23:59:59.999Z");
  });

  it("rolls over month boundaries", () => {
    expect(endingBefore(7, new Date("2026-08-28T00:00:00.000Z"))).toBe("2026-09-04T23:59:59.999Z");
  });

  // The reason it quantises at all: an unrounded `now + N days` would make
  // every request its own `getCachedEvents` key and neuter the ~60s cache.
  it("returns the same bound all day, so the cache key is stable", () => {
    const justAfterMidnight = endingBefore(7, new Date("2026-08-15T00:00:00.001Z"));
    const lateEvening = endingBefore(7, new Date("2026-08-15T23:58:00.000Z"));

    expect(justAfterMidnight).toBe(lateEvening);
  });
});

describe("endingAfter", () => {
  it("floors to the start of the current UTC hour", () => {
    expect(endingAfter(new Date("2026-08-15T14:42:40.123Z"))).toBe("2026-08-15T14:00:00.000Z");
  });

  it("returns the same bound for the whole hour, keeping the cache key stable", () => {
    expect(endingAfter(new Date("2026-08-15T14:00:00.000Z"))).toBe(
      endingAfter(new Date("2026-08-15T14:59:59.999Z")),
    );
  });

  it("advances to the next hour", () => {
    expect(endingAfter(new Date("2026-08-15T15:00:00.000Z"))).toBe("2026-08-15T15:00:00.000Z");
  });
});

describe("isLiveEvent", () => {
  const now = new Date("2026-08-15T14:42:40Z");

  it("rejects an event whose end date has passed", () => {
    // The real case this exists for: search returned "Bitcoin ETF Flows on
    // August 14?" — ended, but still flagged open by Gamma.
    expect(isLiveEvent({ endDate: "2026-08-14T22:00:00Z", closed: false }, now)).toBe(false);
  });

  it("accepts an event ending in the future", () => {
    expect(isLiveEvent({ endDate: "2026-09-16T00:00:00Z", closed: false }, now)).toBe(true);
  });

  it("rejects a closed event regardless of its end date", () => {
    expect(isLiveEvent({ endDate: "2027-01-01T00:00:00Z", closed: true }, now)).toBe(false);
  });

  it("keeps undated events, unlike the server-side bound", () => {
    // Real, tradeable markets land here — undated esports tournament winners
    // with $1M+ volume. `end_date_min` drops them because the API can't
    // express "null or future"; in memory we can.
    expect(isLiveEvent({ endDate: undefined, closed: false }, now)).toBe(true);
  });

  it("keeps an event whose end date is unparseable rather than hiding it", () => {
    expect(isLiveEvent({ endDate: "not-a-date", closed: false }, now)).toBe(true);
  });

  it("treats an event ending exactly now as still live", () => {
    expect(isLiveEvent({ endDate: now.toISOString(), closed: false }, now)).toBe(true);
  });
});
