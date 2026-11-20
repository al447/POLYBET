import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAIN_LEAGUES } from "./fixtures-types";
import type { GammaMarket, KeysetPage, ListMarketsParams } from "./gamma-types";

/**
 * `listMarkets` is mocked rather than exercised: what is under test here is the
 * per-league fan-out in `fetchFixtures`, not Gamma's wire format.
 */
const listMarkets = vi.fn<(params: ListMarketsParams) => Promise<KeysetPage<GammaMarket>>>();

vi.mock("./gamma", () => ({
  listMarkets: (params: ListMarketsParams) => listMarkets(params),
}));

const { fetchFixtures } = await import("./fixtures");

function leg(eventSlug: string, groupItemTitle: string): GammaMarket {
  return {
    id: `${eventSlug}:${groupItemTitle}`,
    conditionId: "0xcond",
    slug: "leg",
    question: "q",
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.4", "0.6"]',
    volume: "0",
    volumeNum: 0,
    liquidity: "0",
    liquidityNum: 0,
    active: true,
    closed: false,
    sportsMarketType: "moneyline",
    acceptingOrders: true,
    groupItemTitle,
    events: [{ slug: eventSlug, title: "Home vs. Away", endDate: "2026-11-21T12:30:00Z", liquidity: 1 }],
  };
}

function matchPage(eventSlug: string): KeysetPage<GammaMarket> {
  return {
    items: [leg(eventSlug, "Home"), leg(eventSlug, "Draw (Home vs. Away)"), leg(eventSlug, "Away")],
    nextCursor: null,
  };
}

beforeEach(() => {
  listMarkets.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchFixtures", () => {
  it("asks each main league once, for moneyline legs inside the window", async () => {
    listMarkets.mockImplementation(async (params) => matchPage(`m-${params.tagId}`));

    const fixtures = await fetchFixtures();

    expect(listMarkets.mock.calls.map(([params]) => params.tagId)).toEqual(
      MAIN_LEAGUES.map((league) => league.tagId),
    );
    for (const [params] of listMarkets.mock.calls) {
      expect(params.sportsMarketTypes).toBe("moneyline");
      expect(params.closed).toBe(false);
      expect(params.endDateMin).toBeTruthy();
      expect(params.endDateMax).toBeTruthy();
    }
    expect(fixtures).toHaveLength(MAIN_LEAGUES.length);
  });

  it("keeps the other leagues when one of them fails", async () => {
    listMarkets.mockImplementation(async (params) => {
      if (params.tagId === MAIN_LEAGUES[0].tagId) throw new Error("boom");
      return matchPage(`m-${params.tagId}`);
    });

    const fixtures = await fetchFixtures();

    expect(fixtures).toHaveLength(MAIN_LEAGUES.length - 1);
    expect(fixtures.some((f) => f.leagueSlug === MAIN_LEAGUES[0].slug)).toBe(false);
  });

  it("throws when every league fails, so the page can tell an outage from an empty week", async () => {
    listMarkets.mockRejectedValue(new Error("gamma down"));

    await expect(fetchFixtures()).rejects.toThrow("gamma down");
  });

  it("returns an empty board, not an error, when no league has matches", async () => {
    listMarkets.mockResolvedValue({ items: [], nextCursor: null });

    await expect(fetchFixtures()).resolves.toEqual([]);
  });

  it("follows a league's cursor but stops at the page cap", async () => {
    listMarkets.mockImplementation(async (params) =>
      params.tagId === MAIN_LEAGUES[0].tagId
        ? { items: [leg("x", "Home")], nextCursor: "next" }
        : { items: [], nextCursor: null },
    );

    await fetchFixtures();

    const firstLeagueCalls = listMarkets.mock.calls.filter(
      ([params]) => params.tagId === MAIN_LEAGUES[0].tagId,
    );
    // MAX_PAGES_PER_LEAGUE in fixtures.ts
    expect(firstLeagueCalls).toHaveLength(3);
    expect(firstLeagueCalls[1][0].cursor).toBe("next");
  });

  it("stops paging once the budget is spent", async () => {
    vi.useFakeTimers();
    const start = Date.now();

    listMarkets.mockImplementation(async (params) => {
      if (params.tagId !== MAIN_LEAGUES[0].tagId) return { items: [], nextCursor: null };
      vi.setSystemTime(start + 11_000);
      return { items: [leg("x", "Home")], nextCursor: "next" };
    });

    await fetchFixtures();

    expect(listMarkets.mock.calls.filter(([p]) => p.tagId === MAIN_LEAGUES[0].tagId)).toHaveLength(1);
  });
});
