import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREDICT_SORT_ID,
  PREDICT_SORTS,
  fixtureMatchesQuery,
  isMatchEvent,
  isPredictSortId,
  leaguesOf,
  parseFixture,
  resolvePredictSort,
  sortFixtures,
} from "./fixtures-types";
import type { Fixture } from "./fixtures-types";
import type { GammaEvent, GammaMarket } from "./gamma-types";

/**
 * Shapes below mirror what Gamma actually returned on 2026-08-19 for
 * `clf-rsd-seg-2026-08-19` — three `moneyline` legs, the draw leg identified
 * only by its `groupItemTitle`, and prices as JSON-encoded string arrays.
 */

function market(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: "1",
    conditionId: "0xcond",
    slug: "leg",
    question: "Will X win on 2026-08-19?",
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.35", "0.65"]',
    volume: "0",
    volumeNum: 0,
    liquidity: "0",
    liquidityNum: 0,
    active: true,
    closed: false,
    sportsMarketType: "moneyline",
    acceptingOrders: true,
    ...overrides,
  };
}

function matchEvent(overrides: Partial<GammaEvent> = {}): GammaEvent {
  return {
    id: "100",
    slug: "clf-rsd-seg-2026-08-19",
    title: "RSD Alcala SAD vs. Gimnastica Segoviana CF",
    endDate: "2026-08-19T09:00:00Z",
    active: true,
    closed: false,
    liquidity: 14349.576,
    tags: [
      { id: "1", label: "Sports", slug: "sports" },
      { id: "100639", label: "Games", slug: "games" },
      { id: "100350", label: "Soccer", slug: "soccer" },
      { id: "105795", label: "Club Friendlies", slug: "clf" },
    ],
    markets: [
      market({ id: "1", groupItemTitle: "RSD Alcala SAD", outcomePrices: '["0.35", "0.65"]' }),
      market({
        id: "2",
        groupItemTitle: "Draw (RSD Alcala SAD vs. Gimnastica Segoviana CF)",
        outcomePrices: '["0.28", "0.72"]',
      }),
      market({
        id: "3",
        groupItemTitle: "Gimnastica Segoviana CF",
        outcomePrices: '["0.355", "0.645"]',
      }),
    ],
    ...overrides,
  };
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    slug: "a",
    homeTeam: "Home",
    awayTeam: "Away",
    leagueSlug: "clf",
    leagueLabel: "Club Friendlies",
    kickoff: "2026-08-19T09:00:00Z",
    liquidity: 100,
    tradeable: true,
    outcomes: [],
    ...overrides,
  };
}

/**
 * The load-bearing filter for the whole Predict AI board.
 *
 * Polymarket publishes seven events per fixture and only one of them is the
 * match. Getting this wrong doesn't error — it lists every match seven times.
 */
describe("isMatchEvent", () => {
  it("accepts an event carrying moneyline markets", () => {
    expect(isMatchEvent(matchEvent())).toBe(true);
  });

  it("rejects the derived events a fixture spawns", () => {
    const exactScore = matchEvent({
      markets: [market({ sportsMarketType: "soccer_exact_score" })],
    });
    const corners = matchEvent({
      markets: [market({ sportsMarketType: "soccer_team_total_corners" })],
    });

    expect(isMatchEvent(exactScore)).toBe(false);
    expect(isMatchEvent(corners)).toBe(false);
  });

  it("rejects a non-sports event, where the field is absent entirely", () => {
    expect(isMatchEvent(matchEvent({ markets: [market({ sportsMarketType: undefined })] }))).toBe(
      false,
    );
  });

  it("does not depend on the title, which is what a dash-splitting filter would break on", () => {
    // A real club name containing " - " must still parse as a match.
    const dashed = matchEvent({ title: "Nottingham - Forest vs. Derby County" });
    expect(isMatchEvent(dashed)).toBe(true);
  });
});

describe("parseFixture", () => {
  it("flattens a live event into home/draw/away with market percentages", () => {
    const result = parseFixture(matchEvent());

    expect(result).not.toBeNull();
    expect(result?.homeTeam).toBe("RSD Alcala SAD");
    expect(result?.awayTeam).toBe("Gimnastica Segoviana CF");
    expect(result?.leagueSlug).toBe("clf");
    expect(result?.leagueLabel).toBe("Club Friendlies");
    expect(result?.outcomes.map((o) => [o.kind, o.label, o.marketPct])).toEqual([
      ["home", "RSD Alcala SAD", 35],
      ["draw", "Draw", 28],
      ["away", "Gimnastica Segoviana CF", 36],
    ]);
  });

  it("uses endDate as kickoff, not startDate", () => {
    // startDate is when Polymarket created the market — months earlier.
    const result = parseFixture(
      matchEvent({ startDate: "2026-03-16T16:13:20Z", endDate: "2026-08-19T09:00:00Z" }),
    );

    expect(result?.kickoff).toBe("2026-08-19T09:00:00Z");
  });

  it("finds the draw by name rather than by position", () => {
    // Same three legs, draw returned first. Position-based parsing would name
    // the draw row "RSD Alcala SAD" — a wrong answer that renders fine.
    const [home, draw, away] = matchEvent().markets;
    const result = parseFixture(matchEvent({ markets: [draw, home, away] }));

    expect(result?.homeTeam).toBe("RSD Alcala SAD");
    expect(result?.outcomes[1]).toMatchObject({ kind: "draw", label: "Draw", marketPct: 28 });
  });

  it("prefers a real order-book quote over the stored outcome price", () => {
    const withQuote = matchEvent({
      markets: [
        market({ groupItemTitle: "Home", bestBid: 0.6, bestAsk: 0.64 }),
        market({ groupItemTitle: "Draw (Home vs. Away)" }),
        market({ groupItemTitle: "Away" }),
      ],
    });

    expect(parseFixture(withQuote)?.outcomes[0].marketPct).toBe(62);
  });

  it("ignores the empty-book sentinel and falls back to the outcome price", () => {
    // bestBid 0 / bestAsk 1 is Gamma's no-liquidity placeholder, not a 50% mid.
    const emptyBook = matchEvent({
      markets: [
        market({ groupItemTitle: "Home", bestBid: 0, bestAsk: 1, outcomePrices: '["0.35","0.65"]' }),
        market({ groupItemTitle: "Draw (Home vs. Away)" }),
        market({ groupItemTitle: "Away" }),
      ],
    });

    expect(parseFixture(emptyBook)?.outcomes[0].marketPct).toBe(35);
  });

  it("marks a fixture untradeable when any leg has stopped accepting orders", () => {
    const settled = matchEvent({
      markets: [
        market({ groupItemTitle: "Home", acceptingOrders: false }),
        market({ groupItemTitle: "Draw (Home vs. Away)" }),
        market({ groupItemTitle: "Away" }),
      ],
    });

    expect(parseFixture(settled)?.tradeable).toBe(false);
    expect(parseFixture(matchEvent())?.tradeable).toBe(true);
  });

  it("returns null rather than throwing on malformed input", () => {
    // One bad event must cost one row, not the whole board.
    expect(parseFixture(matchEvent({ markets: [] }))).toBeNull();
    expect(parseFixture(matchEvent({ markets: matchEvent().markets.slice(0, 2) }))).toBeNull();
    expect(parseFixture(matchEvent({ endDate: undefined }))).toBeNull();
    expect(parseFixture(matchEvent({ endDate: "not a date" }))).toBeNull();
  });

  it("returns null when no leg identifies itself as the draw", () => {
    const noDraw = matchEvent({
      markets: [
        market({ groupItemTitle: "Home" }),
        market({ groupItemTitle: "Middle" }),
        market({ groupItemTitle: "Away" }),
      ],
    });

    expect(parseFixture(noDraw)).toBeNull();
  });

  it("falls back to 'Other' when the event carries no league tag", () => {
    const untagged = matchEvent({
      tags: [{ id: "100350", label: "Soccer", slug: "soccer" }],
    });

    expect(parseFixture(untagged)?.leagueSlug).toBe("other");
    expect(parseFixture(untagged)?.leagueLabel).toBe("Other");
  });
});

describe("leaguesOf", () => {
  it("counts fixtures per league and orders by label", () => {
    const leagues = leaguesOf([
      fixture({ slug: "a", leagueSlug: "mls", leagueLabel: "MLS" }),
      fixture({ slug: "b", leagueSlug: "clf", leagueLabel: "Club Friendlies" }),
      fixture({ slug: "c", leagueSlug: "mls", leagueLabel: "MLS" }),
    ]);

    expect(leagues).toEqual([
      { slug: "clf", label: "Club Friendlies", count: 1 },
      { slug: "mls", label: "MLS", count: 2 },
    ]);
  });

  it("returns an empty list for no fixtures", () => {
    expect(leaguesOf([])).toEqual([]);
  });
});

describe("sortFixtures", () => {
  const early = fixture({ slug: "early", kickoff: "2026-08-19T09:00:00Z", liquidity: 10 });
  const late = fixture({ slug: "late", kickoff: "2026-08-21T09:00:00Z", liquidity: 999 });
  const middle = fixture({
    slug: "middle",
    kickoff: "2026-08-20T09:00:00Z",
    liquidity: 500,
    leagueLabel: "AAA League",
  });

  it("orders by kickoff soonest-first by default", () => {
    expect(sortFixtures([late, early, middle], "kickoff").map((f) => f.slug)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("orders by liquidity, highest first", () => {
    expect(sortFixtures([early, middle, late], "liquidity").map((f) => f.slug)).toEqual([
      "late",
      "middle",
      "early",
    ]);
  });

  it("groups by league label and keeps each league in playing order", () => {
    expect(sortFixtures([late, early, middle], "league").map((f) => f.slug)).toEqual([
      "middle", // "AAA League"
      "early", // "Club Friendlies", earlier kickoff
      "late",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [late, early];
    sortFixtures(input, "kickoff");

    expect(input.map((f) => f.slug)).toEqual(["late", "early"]);
  });
});

describe("fixtureMatchesQuery", () => {
  const target = fixture({
    homeTeam: "Atlético Madrid",
    awayTeam: "Málaga",
    leagueLabel: "La Liga",
  });

  it("matches either team or the league, case-insensitively", () => {
    expect(fixtureMatchesQuery(target, "atlético")).toBe(true);
    expect(fixtureMatchesQuery(target, "MÁLAGA")).toBe(true);
    expect(fixtureMatchesQuery(target, "la liga")).toBe(true);
  });

  it("matches on a partial word, so typing narrows as you go", () => {
    expect(fixtureMatchesQuery(target, "mad")).toBe(true);
  });

  it("keeps everything for an empty or whitespace query", () => {
    expect(fixtureMatchesQuery(target, "")).toBe(true);
    expect(fixtureMatchesQuery(target, "   ")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(fixtureMatchesQuery(target, "arsenal")).toBe(false);
  });
});

describe("resolvePredictSort", () => {
  it("resolves every declared id to its own entry", () => {
    for (const sort of PREDICT_SORTS) {
      expect(resolvePredictSort(sort.id)).toBe(sort);
    }
  });

  it("falls back to the default for unknown, null and undefined ids", () => {
    const fallback = resolvePredictSort(DEFAULT_PREDICT_SORT_ID);

    expect(resolvePredictSort("nonsense")).toBe(fallback);
    expect(resolvePredictSort(null)).toBe(fallback);
    expect(resolvePredictSort(undefined)).toBe(fallback);
  });

  it("defaults to kickoff order", () => {
    expect(resolvePredictSort(undefined).id).toBe("kickoff");
  });

  it("guards ids", () => {
    expect(isPredictSortId("liquidity")).toBe(true);
    expect(isPredictSortId("nonsense")).toBe(false);
  });
});
