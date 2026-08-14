import { describe, expect, it } from "vitest";
import type { Activity } from "@polymarket/bindings/data";

import { describeActivity, describeActivityList } from "./activity";

/**
 * Fixtures cast through `unknown` rather than restating nine branded schemas —
 * same approach as `portfolio.test.ts` and `redeem.test.ts`. Only the fields
 * `describeActivity` reads are set.
 */
function activity(fields: Record<string, unknown>): Activity {
  return {
    timestamp: 1_700_000_000_000,
    transactionHash: "0xtx",
    ...fields,
  } as unknown as Activity;
}

describe("describeActivity — trades", () => {
  it("reads a CLOB buy as cash leaving the account", () => {
    const entry = describeActivity(
      activity({
        type: "TRADE",
        isCombo: false,
        side: "BUY",
        shares: "12",
        amount: "6.48",
        price: "0.54",
        title: "Will X happen?",
        icon: "https://example.test/x.png",
        outcome: "Yes",
        slug: "will-x-happen-market",
        eventSlug: "will-x-happen",
      }),
    );

    expect(entry.kind).toBe("trade");
    expect(entry.label).toBe("Bought");
    expect(entry.direction).toBe("out");
    expect(entry.side).toBe("BUY");
    expect(entry.shares).toBe(12);
    expect(entry.price).toBe(0.54);
    expect(entry.amount).toBe(6.48);
    expect(entry.outcome).toBe("Yes");
  });

  it("reads a CLOB sell as cash arriving", () => {
    const entry = describeActivity(
      activity({
        type: "TRADE",
        isCombo: false,
        side: "SELL",
        shares: "5",
        amount: "3.10",
        price: "0.62",
        title: "Will X happen?",
        icon: null,
        outcome: "No",
        slug: "m",
        eventSlug: "will-x-happen",
      }),
    );

    expect(entry.label).toBe("Sold");
    expect(entry.direction).toBe("in");
    expect(entry.side).toBe("SELL");
  });

  it("links a CLOB trade by event slug, never the market slug", () => {
    // The detail route resolves event slugs; a market slug 404s.
    const entry = describeActivity(
      activity({
        type: "TRADE",
        isCombo: false,
        side: "BUY",
        shares: "1",
        amount: "1",
        price: "1",
        title: "t",
        icon: null,
        outcome: "Yes",
        slug: "market-slug",
        eventSlug: "event-slug",
      }),
    );

    expect(entry.eventSlug).toBe("event-slug");
  });

  it("leaves a combo trade unlinked and without an outcome label", () => {
    // ComboTradeActivity genuinely has no eventSlug or outcome field — reading
    // one would be undefined at runtime and a type error at compile time.
    const entry = describeActivity(
      activity({
        type: "TRADE",
        isCombo: true,
        side: "BUY",
        shares: "3",
        amount: "1.50",
        price: "0.50",
        title: "Some combo",
        icon: null,
        positionId: "123",
      }),
    );

    expect(entry.kind).toBe("trade");
    expect(entry.title).toBe("Some combo");
    expect(entry.eventSlug).toBeNull();
    expect(entry.outcome).toBeNull();
  });
});

describe("describeActivity — settlements", () => {
  it("treats a split as collateral leaving and a merge as collateral arriving", () => {
    const split = describeActivity(
      activity({ type: "SPLIT", amount: "20", title: "M", icon: null, eventSlug: "e", conditionId: "0xc", slug: "s" }),
    );
    const merge = describeActivity(
      activity({ type: "MERGE", amount: "20", title: "M", icon: null, eventSlug: "e", conditionId: "0xc", slug: "s" }),
    );

    expect(split.label).toBe("Split");
    expect(split.direction).toBe("out");
    expect(merge.label).toBe("Merged");
    expect(merge.direction).toBe("in");
    expect(split.kind).toBe("settlement");
  });

  it("reads a redemption as proceeds arriving", () => {
    const entry = describeActivity(
      activity({
        type: "REDEEM",
        amount: "14.75",
        title: "Resolved market",
        icon: null,
        eventSlug: "resolved-market",
        conditionId: "0xc",
        slug: "s",
      }),
    );

    expect(entry.label).toBe("Redeemed");
    expect(entry.direction).toBe("in");
    expect(entry.amount).toBe(14.75);
    expect(entry.eventSlug).toBe("resolved-market");
  });

  it("renders a conversion unsigned rather than guessing which way it moved", () => {
    const entry = describeActivity(
      activity({ type: "CONVERSION", amount: "8", title: "M", icon: null, eventSlug: "e", conditionId: "0xc", slug: "s" }),
    );

    expect(entry.label).toBe("Converted");
    expect(entry.direction).toBe("neutral");
    expect(entry.amount).toBe(8);
  });
});

describe("describeActivity — account credits", () => {
  it.each([
    ["REWARD", "Reward"],
    ["MAKER_REBATE", "Maker rebate"],
    ["REFERRAL_REWARD", "Referral reward"],
    ["YIELD", "Yield"],
  ])("reads %s as an incoming credit with no market attached", (type, label) => {
    const entry = describeActivity(activity({ type, amount: "0.42" }));

    expect(entry.kind).toBe("credit");
    expect(entry.label).toBe(label);
    expect(entry.direction).toBe("in");
    expect(entry.amount).toBe(0.42);
    // These variants carry no market context whatsoever.
    expect(entry.title).toBeNull();
    expect(entry.eventSlug).toBeNull();
    expect(entry.icon).toBeNull();
    expect(entry.side).toBeNull();
    expect(entry.shares).toBeNull();
  });
});

describe("describeActivity — defensive parsing", () => {
  it("treats unparseable amounts as zero instead of NaN", () => {
    const entry = describeActivity(activity({ type: "REWARD", amount: "not-a-number" }));

    expect(entry.amount).toBe(0);
    expect(Number.isNaN(entry.amount)).toBe(false);
  });

  it("carries the timestamp and transaction hash through every variant", () => {
    const entry = describeActivity(
      activity({ type: "YIELD", amount: "1", timestamp: 1_699_999_999_000, transactionHash: "0xdeadbeef" }),
    );

    expect(entry.timestamp).toBe(1_699_999_999_000);
    expect(entry.transactionHash).toBe("0xdeadbeef");
  });
});

describe("describeActivityList", () => {
  it("gives colliding rows in one transaction distinct keys", () => {
    // The case that matters: Activity has no id, and one transaction can emit
    // several identical-looking fills. Without the occurrence counter React
    // would drop all but one.
    const entries = describeActivityList([
      activity({ type: "TRADE", isCombo: false, side: "BUY", shares: "1", amount: "1", price: "1", title: "t", icon: null, outcome: "Yes", slug: "s", eventSlug: "e", transactionHash: "0xsame" }),
      activity({ type: "TRADE", isCombo: false, side: "BUY", shares: "1", amount: "1", price: "1", title: "t", icon: null, outcome: "Yes", slug: "s", eventSlug: "e", transactionHash: "0xsame" }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0].key).not.toBe(entries[1].key);
  });

  it("separates different activity types sharing one transaction hash", () => {
    const entries = describeActivityList([
      activity({ type: "REDEEM", amount: "5", title: "M", icon: null, eventSlug: "e", conditionId: "0xc", slug: "s", transactionHash: "0xsame" }),
      activity({ type: "REWARD", amount: "5", transactionHash: "0xsame" }),
    ]);

    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
  });

  it("preserves input order", () => {
    const entries = describeActivityList([
      activity({ type: "REWARD", amount: "1" }),
      activity({ type: "YIELD", amount: "2" }),
    ]);

    expect(entries.map((e) => e.label)).toEqual(["Reward", "Yield"]);
  });

  it("returns nothing for an empty feed", () => {
    expect(describeActivityList([])).toEqual([]);
  });
});
