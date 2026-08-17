import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORDERING_ID,
  DEFAULT_PERIOD_ID,
  LEADERBOARD_ORDERINGS,
  LEADERBOARD_PERIODS,
  isOrderingId,
  isPeriodId,
  resolveOrdering,
  resolvePeriod,
  traderDisplayName,
} from "./leaderboard-types";

/**
 * Period and ordering presets.
 *
 * The point of these is less "does find() work" and more that an unverified
 * `timePeriod` can never reach the wire. The endpoint ignores parameters it
 * doesn't recognise instead of rejecting them, so a bad value returns
 * plausible data for the wrong window — a failure with no error attached to
 * it.
 */
describe("resolvePeriod", () => {
  it("resolves every declared id to its own entry", () => {
    for (const period of LEADERBOARD_PERIODS) {
      expect(resolvePeriod(period.id)).toBe(period);
    }
  });

  it("falls back to the default for unknown, null and undefined ids", () => {
    const fallback = resolvePeriod(DEFAULT_PERIOD_ID);

    expect(resolvePeriod("1y")).toBe(fallback);
    expect(resolvePeriod(null)).toBe(fallback);
    expect(resolvePeriod(undefined)).toBe(fallback);
  });

  it("pins the API's own enum values, not our ids", () => {
    // Verified live 2026-08-17 — these are the exact `timePeriod` values the
    // endpoint accepts. `window` is not a parameter at all.
    expect(LEADERBOARD_PERIODS.map((period) => period.timePeriod)).toEqual([
      "DAY",
      "WEEK",
      "MONTH",
      "ALL",
    ]);
  });

  it("defaults to the week, which is what the copy-trade page's heading claims", () => {
    expect(resolvePeriod(undefined).timePeriod).toBe("WEEK");
  });
});

describe("resolveOrdering", () => {
  it("resolves every declared id to its own entry", () => {
    for (const ordering of LEADERBOARD_ORDERINGS) {
      expect(resolveOrdering(ordering.id)).toBe(ordering);
    }
  });

  it("falls back to the default for unknown ids", () => {
    expect(resolveOrdering("profitability")).toBe(resolveOrdering(DEFAULT_ORDERING_ID));
  });

  it("pins the API's own enum values", () => {
    expect(LEADERBOARD_ORDERINGS.map((ordering) => ordering.orderBy)).toEqual(["PNL", "VOL"]);
  });
});

describe("isPeriodId / isOrderingId", () => {
  it("accepts declared ids and rejects everything else", () => {
    expect(isPeriodId("1w")).toBe(true);
    expect(isPeriodId("WEEK")).toBe(false); // the wire value is not an id
    expect(isPeriodId("")).toBe(false);

    expect(isOrderingId("volume")).toBe(true);
    expect(isOrderingId("VOL")).toBe(false);
  });
});

/**
 * Display names.
 *
 * Every case below is a real shape observed in a 50-row sample on 2026-08-17,
 * not a hypothetical. The address-shaped username is the one that matters:
 * rendered verbatim it is 55 characters and overflows the card.
 */
describe("traderDisplayName", () => {
  const address = "0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf";

  it("keeps a real chosen name", () => {
    expect(traderDisplayName("WTSA", address)).toBe("WTSA");
    expect(traderDisplayName("AvrahamEisenberg - 10161", address)).toBe(
      "AvrahamEisenberg - 10161",
    );
  });

  it("shortens the address when the username is Polymarket's address placeholder", () => {
    expect(
      traderDisplayName("0x3DFb153c197D4C19D3B31c1ecD2c7B6860eeabAf-1722957908185", address),
    ).toBe("0x3dfb…abaf");
  });

  it("shortens the address when the username is empty or whitespace", () => {
    expect(traderDisplayName("", address)).toBe("0x3dfb…abaf");
    expect(traderDisplayName("   ", address)).toBe("0x3dfb…abaf");
    expect(traderDisplayName(undefined, address)).toBe("0x3dfb…abaf");
  });

  it("trims surrounding whitespace off a real name", () => {
    expect(traderDisplayName("  RWCS  ", address)).toBe("RWCS");
  });
});
