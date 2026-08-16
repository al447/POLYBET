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
  rankEventOutcomes,
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

/**
 * Outcome ranking (the hero's left column, and anything else that needs "what
 * are the top few outcomes and what are they trading at").
 *
 * The interesting part is that Gamma expresses "outcome" two incompatible
 * ways — one market with a Yes/No pair, or many markets each standing for one
 * outcome — and callers must not have to branch on it.
 */
describe("rankEventOutcomes", () => {
  const binaryMarket = {
    id: "1",
    conditionId: "0x1",
    slug: "bitcoin-up",
    question: "Will Bitcoin be up today?",
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.62","0.39"]',
    clobTokenIds: '["tok-yes","tok-no"]',
    volume: "1",
    volumeNum: 1,
    liquidity: "1",
    liquidityNum: 1,
    active: true,
    closed: false,
  };

  function leg(id: string, title: string, price: string, token: string) {
    return {
      ...binaryMarket,
      id,
      groupItemTitle: title,
      question: `Will ${title} win?`,
      outcomePrices: `["${price}","${(1 - Number(price)).toFixed(2)}"]`,
      clobTokenIds: `["${token}","${token}-no"]`,
    };
  }

  it("reads a binary event's Yes/No off the single market", () => {
    expect(rankEventOutcomes({ markets: [binaryMarket] })).toEqual([
      { label: "Yes", pct: 62, tokenId: "tok-yes" },
      { label: "No", pct: 39, tokenId: "tok-no" },
    ]);
  });

  it("treats each market as one outcome on a multi-market event", () => {
    const ranked = rankEventOutcomes({
      markets: [leg("2", "Tom Tiffany (R)", "0.24", "tok-t"), leg("3", "David Crowley (D)", "0.77", "tok-c")],
    });

    // Sorted by price, and labelled with the short `groupItemTitle` rather
    // than the full question.
    expect(ranked.map((row) => row.label)).toEqual(["David Crowley (D)", "Tom Tiffany (R)"]);
    expect(ranked[0]).toEqual({ label: "David Crowley (D)", pct: 77, tokenId: "tok-c" });
  });

  it("sorts unpriced outcomes last instead of treating them as 0%", () => {
    const unpriced = { ...leg("4", "Unpriced", "0.10", "tok-u"), outcomePrices: "[]", bestBid: 0, bestAsk: 1 };
    const ranked = rankEventOutcomes({
      markets: [unpriced, leg("5", "Priced", "0.05", "tok-p")],
    });

    expect(ranked[0].label).toBe("Priced");
    expect(ranked[1].pct).toBeNull();
  });

  it("returns an empty list for an event with no markets", () => {
    expect(rankEventOutcomes({ markets: [] })).toEqual([]);
  });

  it("drops legs that have already settled inside a still-open event", () => {
    // Real shape, verified 2026-08-16 on the Israel/Iran ceasefire event: 17
    // of 22 legs closed at exactly 1.00 while the event stayed open. Without
    // this filter the hero led with three settled 100% outcomes.
    const settled = {
      ...leg("6", "July 18", "0.5", "tok-j18"),
      closed: true,
      outcomePrices: '["1","0"]',
    };
    const ranked = rankEventOutcomes({
      markets: [settled, leg("7", "August 31", "0.93", "tok-a31")],
    });

    expect(ranked).toEqual([{ label: "August 31", pct: 93, tokenId: "tok-a31" }]);
  });

  it("still labels the survivor as an outcome, not a Yes/No pair", () => {
    // One market left after filtering must not be mistaken for a binary
    // market — the branch keys off the original count for this reason.
    const settled = { ...leg("8", "July 18", "0.5", "tok-j18"), closed: true };
    const ranked = rankEventOutcomes({
      markets: [settled, leg("9", "August 31", "0.93", "tok-a31")],
    });

    expect(ranked.map((row) => row.label)).toEqual(["August 31"]);
  });

  it("returns nothing when every leg has settled", () => {
    // The hero skips such an event entirely rather than featuring dead markets.
    const settled = { ...leg("10", "July 18", "0.5", "tok-j18"), closed: true };
    expect(rankEventOutcomes({ markets: [settled, { ...settled, id: "11" }] })).toEqual([]);
  });

  it("falls back to the question when a binary market has no parseable outcomes", () => {
    const ranked = rankEventOutcomes({
      markets: [{ ...binaryMarket, outcomes: "not json", bestBid: 0.5, bestAsk: 0.54 }],
    });
    expect(ranked).toEqual([{ label: "Will Bitcoin be up today?", pct: 52, tokenId: "tok-yes" }]);
  });
});
