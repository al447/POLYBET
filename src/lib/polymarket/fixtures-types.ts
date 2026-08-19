import { snapshotPrice } from "./gamma-types";
import type { GammaEvent, GammaMarket } from "./gamma-types";

/**
 * Football fixture shapes and presets, for the Predict AI page (FR-7.1).
 *
 * Deliberately NOT `server-only`, mirroring the `gamma-types.ts` / `gamma.ts`
 * and `leaderboard-types.ts` / `leaderboard.ts` split. `fixtures.ts` (the fetch
 * client) IS `server-only`, but `FixtureBoard` runs in the browser and needs
 * these shapes and sort ids without dragging `server-only`'s throwing guard
 * into the client bundle.
 *
 * ⚠️ Prices here are the same "good enough to browse by, not to trade at"
 * snapshot as everywhere else in this codebase. Nothing in this file may inform
 * an order — it is a listing feed, not a price feed.
 *
 * Verified live against Gamma 2026-08-19: 176 base matches across 53 leagues in
 * a 7-day window.
 */

/**
 * The `sportsMarketType` that identifies a match-result market.
 *
 * 🚩 This is the whole trick to listing fixtures. Polymarket publishes **seven**
 * Gamma events per football match — the match itself plus `- Halftime Result`,
 * `- Second Half Result`, `- Exact Score`, `- First Team to Score`,
 * `- Total Corners` and `- More Markets` — and every one of them carries the
 * same tags, the same `endDate` and the same team names. Listing them all shows
 * each fixture seven times.
 *
 * Measured across 1200 soccer events on 2026-08-19: 528 markets carry
 * `"moneyline"`, which is exactly 176 matches x 3 legs (home / draw / away).
 * Splitting on `" - "` in the event title looks like it would do the same job
 * and does not — club names contain dashes, and a false positive there silently
 * drops a real fixture off the board.
 */
const MONEYLINE = "moneyline";

/** Gamma's `Soccer` tag. Verified live 2026-08-19 via `GET /tags/slug/soccer`. */
export const SOCCER_TAG_ID = 100350;

/**
 * How far ahead the board looks.
 *
 * Seven days is a deliberate ceiling, not a display preference: the derived
 * events above are ~85% of the payload, so a 7-day window costs ~1200 events
 * fetched to yield ~176 rows. Widening it multiplies the paging cost for
 * fixtures nobody is looking at yet.
 */
export const FIXTURE_WINDOW_DAYS = 7;

/** Tags every soccer fixture carries, so they can never be mistaken for the league. */
const NON_LEAGUE_TAG_SLUGS = new Set(["sports", "games", "soccer"]);

/** One result a match can end in, with what the market currently prices it at. */
export type FixtureOutcome = {
  kind: "home" | "draw" | "away";
  /** Team name, or "Draw". */
  label: string;
  /** 0-100, rounded. `null` when Gamma gave no usable price. */
  marketPct: number | null;
};

/** One football match, flattened from the Gamma event that represents it. */
export type Fixture = {
  /** Event slug, e.g. `clf-rsd-seg-2026-08-19`. Links to `/market/[slug]`. */
  slug: string;
  homeTeam: string;
  awayTeam: string;
  /** Gamma tag slug, e.g. `la-liga`. The stable id the league chips filter on. */
  leagueSlug: string;
  /** Gamma tag label, e.g. `La Liga`. Display only. */
  leagueLabel: string;
  /**
   * Kickoff, ISO 8601.
   *
   * 🚩 This is the event's `endDate`, not its `startDate`. `startDate` is when
   * Polymarket created the market — often months earlier — so sorting or
   * grouping on it produces a board in creation order with no relation to when
   * anything is played.
   */
  kickoff: string;
  liquidity: number;
  /** Every moneyline leg is open and taking orders. */
  tradeable: boolean;
  /** Always home, draw, away in that order — the reading order of the row. */
  outcomes: FixtureOutcome[];
};

/**
 * How the board is ordered. Ids travel as one opaque token, same discipline as
 * `EVENT_SORTS`, `PRICE_RANGES` and `LEADERBOARD_PERIODS`.
 */
export const PREDICT_SORTS = [
  { id: "kickoff", label: "Kickoff" },
  { id: "league", label: "League" },
  { id: "liquidity", label: "Liquidity" },
] as const satisfies readonly { id: string; label: string }[];

export type PredictSort = (typeof PREDICT_SORTS)[number];
export type PredictSortId = PredictSort["id"];

/** Soonest first — the only ordering that makes a fixture list readable by default. */
export const DEFAULT_PREDICT_SORT_ID: PredictSortId = "kickoff";

// Looked up by id, not by index, so reordering the chips can never silently
// change what an unrecognised value falls back to.
const DEFAULT_PREDICT_SORT: PredictSort =
  PREDICT_SORTS.find((sort) => sort.id === DEFAULT_PREDICT_SORT_ID) ?? PREDICT_SORTS[0];

export function isPredictSortId(value: string): value is PredictSortId {
  return PREDICT_SORTS.some((sort) => sort.id === value);
}

/** Resolves a wire value to a sort, falling back to the default on anything unrecognised. */
export function resolvePredictSort(id: string | null | undefined): PredictSort {
  return PREDICT_SORTS.find((sort) => sort.id === id) ?? DEFAULT_PREDICT_SORT;
}

/** True when this event is a match's base result market rather than one of its six derivatives. */
export function isMatchEvent(event: Pick<GammaEvent, "markets">): boolean {
  return (event.markets ?? []).some((market) => market.sportsMarketType === MONEYLINE);
}

/**
 * 0-100 chance the market gives this leg.
 *
 * Each leg is its own binary market with `outcomes: ["Yes","No"]`, so the *first*
 * outcome price is the chance of that result — which is exactly what
 * `snapshotPrice` returns, including its handling of the `bestBid 0 / bestAsk 1`
 * empty-book sentinel. Reused rather than reimplemented so there is one place
 * that decides what a browse-by price is.
 */
function legPct(market: GammaMarket): number | null {
  const price = snapshotPrice(market);
  return price === null ? null : Math.round(price * 100);
}

/** The league tag, or `null` when the event carries none beyond the generic three. */
function leagueTagOf(event: Pick<GammaEvent, "tags">) {
  return (
    (event.tags ?? []).find(
      (tag) => tag.slug !== null && tag.slug !== undefined && !NON_LEAGUE_TAG_SLUGS.has(tag.slug),
    ) ?? null
  );
}

/**
 * Flattens a Gamma event into a `Fixture`, or `null` if it isn't a well-formed
 * match.
 *
 * Returns `null` rather than throwing on every unrecognised shape: this runs
 * over a few hundred events per cache fill, and one malformed fixture must cost
 * exactly one row, not the whole board.
 *
 * 🚩 The draw leg is found by `groupItemTitle`, not by position. Gamma returns
 * the three legs as `[home, draw, away]` and has done so on every sample, but
 * that ordering is undocumented, and getting it wrong swaps a team's name onto
 * the draw row — a wrong answer that looks exactly like a right one. The draw
 * leg is self-identifying (`"Draw (Home vs. Away)"`), so it is matched by name
 * and the remaining pair keeps its relative order, which the event *title*
 * independently confirms as home-then-away.
 */
export function parseFixture(event: GammaEvent): Fixture | null {
  const legs = (event.markets ?? []).filter((market) => market.sportsMarketType === MONEYLINE);
  if (legs.length !== 3) return null;

  const drawLeg = legs.find((leg) => (leg.groupItemTitle ?? "").startsWith("Draw"));
  if (!drawLeg) return null;

  const [homeLeg, awayLeg] = legs.filter((leg) => leg !== drawLeg);
  if (!homeLeg || !awayLeg) return null;

  const homeTeam = (homeLeg.groupItemTitle ?? "").trim();
  const awayTeam = (awayLeg.groupItemTitle ?? "").trim();
  if (!homeTeam || !awayTeam) return null;

  const kickoff = event.endDate;
  if (!kickoff || Number.isNaN(Date.parse(kickoff))) return null;

  const league = leagueTagOf(event);

  return {
    slug: event.slug,
    homeTeam,
    awayTeam,
    leagueSlug: league?.slug ?? "other",
    leagueLabel: league?.label ?? "Other",
    kickoff,
    liquidity: Number(event.liquidity ?? 0) || 0,
    tradeable: legs.every((leg) => leg.closed !== true && leg.acceptingOrders !== false),
    outcomes: [
      { kind: "home", label: homeTeam, marketPct: legPct(homeLeg) },
      { kind: "draw", label: "Draw", marketPct: legPct(drawLeg) },
      { kind: "away", label: awayTeam, marketPct: legPct(awayLeg) },
    ],
  };
}

/** One entry in the league chip row. */
export type FixtureLeague = { slug: string; label: string; count: number };

/** Leagues present in a fixture list, with counts, ordered by label for a stable chip row. */
export function leaguesOf(fixtures: readonly Fixture[]): FixtureLeague[] {
  const byslug = new Map<string, FixtureLeague>();

  for (const fixture of fixtures) {
    const existing = byslug.get(fixture.leagueSlug);
    if (existing) {
      existing.count += 1;
    } else {
      byslug.set(fixture.leagueSlug, {
        slug: fixture.leagueSlug,
        label: fixture.leagueLabel,
        count: 1,
      });
    }
  }

  return [...byslug.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Sorts a copy of `fixtures` by the given sort id. Pure — never mutates the input. */
export function sortFixtures(fixtures: readonly Fixture[], sortId: PredictSortId): Fixture[] {
  const sorted = [...fixtures];

  switch (sortId) {
    case "liquidity":
      return sorted.sort((a, b) => b.liquidity - a.liquidity);
    case "league":
      // Kickoff is the tiebreak, so a league's own fixtures stay in playing order.
      return sorted.sort(
        (a, b) =>
          a.leagueLabel.localeCompare(b.leagueLabel) ||
          Date.parse(a.kickoff) - Date.parse(b.kickoff),
      );
    case "kickoff":
    default:
      return sorted.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  }
}

/** Case-insensitive match on either team or the league name — what the search box filters on. */
export function fixtureMatchesQuery(fixture: Fixture, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return (
    fixture.homeTeam.toLowerCase().includes(needle) ||
    fixture.awayTeam.toLowerCase().includes(needle) ||
    fixture.leagueLabel.toLowerCase().includes(needle)
  );
}
