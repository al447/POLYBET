import { describe, expect, it } from "vitest";
import type { Position } from "@polymarket/bindings/data";

import { groupRedeemable, totalClaimable } from "./redeem";

/**
 * Only the fields `groupRedeemable` reads are set — the rest of `Position` is
 * branded/optional and irrelevant here, so fixtures cast through `unknown`
 * rather than restating the whole schema (same approach as `portfolio.test.ts`).
 */
type Fields = Partial<{
  conditionId: string;
  redeemable: boolean | null;
  outcome: string | null;
  size: string | null;
  currentValue: string | null;
  title: string | null;
  icon: string | null;
  eventSlug: string | null;
}>;

function position(fields: Fields): Position {
  return fields as unknown as Position;
}

describe("groupRedeemable", () => {
  it("collapses both sides of one condition into a single claim", () => {
    // The case that motivates grouping: redeemPositions settles the whole
    // condition, so offering this as two rows would spend a second relay
    // transaction to redeem nothing.
    const markets = groupRedeemable([
      position({ conditionId: "0xabc", redeemable: true, outcome: "Yes", size: "10", currentValue: "10" }),
      position({ conditionId: "0xabc", redeemable: true, outcome: "No", size: "4", currentValue: "0" }),
    ]);

    expect(markets).toHaveLength(1);
    expect(markets[0].conditionId).toBe("0xabc");
    expect(markets[0].outcomes).toEqual(["Yes", "No"]);
    expect(markets[0].shares).toBe(14);
    expect(markets[0].payout).toBe(10);
  });

  it("keeps separate conditions separate", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xabc", redeemable: true, size: "1", currentValue: "5" }),
      position({ conditionId: "0xdef", redeemable: true, size: "1", currentValue: "7" }),
    ]);

    expect(markets.map((m) => m.conditionId)).toEqual(["0xdef", "0xabc"]);
  });

  it("excludes positions that are not redeemable", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xopen", redeemable: false, size: "10", currentValue: "6" }),
      position({ conditionId: "0xunset", size: "10", currentValue: "6" }),
      position({ conditionId: "0xnull", redeemable: null, size: "10", currentValue: "6" }),
      position({ conditionId: "0xdone", redeemable: true, size: "10", currentValue: "6" }),
    ]);

    expect(markets.map((m) => m.conditionId)).toEqual(["0xdone"]);
  });

  it("keeps a zero-payout claim rather than risk hiding one the API under-reported", () => {
    // A null currentValue is indistinguishable from a genuine $0, so the row
    // is shown with its figure and the user decides — see the docstring.
    const markets = groupRedeemable([
      position({ conditionId: "0xlost", redeemable: true, size: "12", currentValue: null }),
    ]);

    expect(markets).toHaveLength(1);
    expect(markets[0].payout).toBe(0);
    expect(markets[0].shares).toBe(12);
  });

  it("drops groups with neither shares nor value", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xdust", redeemable: true, size: "0", currentValue: "0" }),
    ]);

    expect(markets).toEqual([]);
  });

  it("sorts by payout, largest claim first", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xsmall", redeemable: true, size: "1", currentValue: "3" }),
      position({ conditionId: "0xbig", redeemable: true, size: "1", currentValue: "50" }),
      position({ conditionId: "0xmid", redeemable: true, size: "1", currentValue: "12" }),
    ]);

    expect(markets.map((m) => m.conditionId)).toEqual(["0xbig", "0xmid", "0xsmall"]);
  });

  it("treats unparseable money fields as zero instead of poisoning a total", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xabc", redeemable: true, size: "5", currentValue: "10" }),
      position({ conditionId: "0xabc", redeemable: true, size: "not-a-number", currentValue: "oops" }),
    ]);

    expect(markets[0].shares).toBe(5);
    expect(markets[0].payout).toBe(10);
    expect(Number.isNaN(markets[0].payout)).toBe(false);
  });

  it("carries display metadata from the first position seen for a condition", () => {
    const markets = groupRedeemable([
      position({
        conditionId: "0xabc",
        redeemable: true,
        size: "1",
        currentValue: "1",
        title: "Will X happen?",
        icon: "https://example.test/i.png",
        eventSlug: "will-x-happen",
      }),
      position({ conditionId: "0xabc", redeemable: true, size: "1", currentValue: "1", title: "ignored" }),
    ]);

    expect(markets[0].title).toBe("Will X happen?");
    expect(markets[0].icon).toBe("https://example.test/i.png");
    expect(markets[0].eventSlug).toBe("will-x-happen");
  });

  it("does not repeat an outcome label held across several positions", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xabc", redeemable: true, outcome: "Yes", size: "1", currentValue: "1" }),
      position({ conditionId: "0xabc", redeemable: true, outcome: "Yes", size: "2", currentValue: "2" }),
    ]);

    expect(markets[0].outcomes).toEqual(["Yes"]);
    expect(markets[0].shares).toBe(3);
  });

  it("returns nothing for no positions", () => {
    expect(groupRedeemable([])).toEqual([]);
  });
});

describe("totalClaimable", () => {
  it("sums payouts across claimable markets", () => {
    const markets = groupRedeemable([
      position({ conditionId: "0xa", redeemable: true, size: "1", currentValue: "10.50" }),
      position({ conditionId: "0xb", redeemable: true, size: "1", currentValue: "4.25" }),
    ]);

    expect(totalClaimable(markets)).toBe(14.75);
  });

  it("is zero for an empty list", () => {
    expect(totalClaimable([])).toBe(0);
  });
});
