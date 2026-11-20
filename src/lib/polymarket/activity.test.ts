import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserClient } from "./browser-client";
import {
  describeActivity,
  describeActivityList,
  fetchActivityPage,
  parseActivityRows,
  type ActivityRow,
} from "./activity";

function activity(fields: Partial<ActivityRow>): ActivityRow {
  return {
    type: "TRADE",
    isCombo: false,
    side: "",
    shares: 0,
    amount: 0,
    price: 0,
    title: null,
    icon: null,
    eventSlug: null,
    outcome: null,
    timestamp: 1_700_000_000_000,
    transactionHash: "0xtx",
    ...fields,
  };
}

/** `/v2/activity` rows captured live 2026-11-19 (hashes and ids shortened). */
const v2Trade = {
  proxy_wallet: "0x2ecb3055976168e95676dc12c10e2000e2d9ecb8",
  timestamp: 1795081964,
  condition_id: "0x5525b3e5c4929b7929af3f261db3e8b92847fdbea7aef504f48ec2a6d4b956b1",
  type: "TRADE",
  size: 240.0,
  usdc_size: 16.8,
  transaction_hash: "0x1a387b9aa472017a187ffdea5a5f2690782f4f93c9152f0834e61a1eba340ec6",
  price: 0.07,
  token_id: "44337808669499624000313491442363224949468898855886252950439100324760032353840",
  side: "BUY",
  outcome_index: 0,
  title: "Will Daniil Medvedev win the 2026 Nitto ATP Finals?",
  slug: "will-daniil-medvedev-win-the-2026-nitto-atp-finals",
  icon: "https://polymarket-upload.s3.us-east-2.amazonaws.com/atp.jpg",
  event_slug: "nitto-atp-finals-2026-winner",
  outcome: "Yes",
  name: "DrSlips",
  pseudonym: "Remorseful-Purchase",
};

const v2Reward = {
  ...v2Trade,
  type: "REWARD",
  size: 56.7647,
  usdc_size: 56.7647,
  price: 0,
  side: "",
  title: "",
  condition_id: "",
  token_id: "",
  icon: "",
  event_slug: "",
  outcome: "",
};

describe("parseActivityRows", () => {
  it("normalises a v2 trade row", () => {
    const [row] = parseActivityRows([v2Trade]);

    expect(row).toEqual({
      type: "TRADE",
      isCombo: false,
      side: "BUY",
      shares: 240,
      amount: 16.8,
      price: 0.07,
      title: v2Trade.title,
      icon: v2Trade.icon,
      eventSlug: "nitto-atp-finals-2026-winner",
      outcome: "Yes",
      timestamp: 1795081964 * 1000,
      transactionHash: v2Trade.transaction_hash,
    });
  });

  // ActivityEntry renders milliseconds; the wire sends seconds
  it("converts the wire's epoch seconds to milliseconds", () => {
    const [row] = parseActivityRows([v2Trade]);
    expect(new Date(row.timestamp).getUTCFullYear()).toBe(2026);
  });

  it("reads empty strings on a credit row as null", () => {
    const [row] = parseActivityRows([v2Reward]);
    expect(row.title).toBeNull();
    expect(row.eventSlug).toBeNull();
    expect(row.icon).toBeNull();
  });

  it("flags combo trades", () => {
    const [row] = parseActivityRows([{ ...v2Trade, is_combo: true }]);
    expect(row.isCombo).toBe(true);
  });

  it("drops rows with no type and survives junk", () => {
    expect(parseActivityRows([{ ...v2Trade, type: "" }, null, 7, "x"])).toEqual([]);
  });

  it("coerces unparseable numbers to zero, never NaN", () => {
    const [row] = parseActivityRows([{ ...v2Trade, usdc_size: "abc", size: null }]);
    expect(row.amount).toBe(0);
    expect(row.shares).toBe(0);
  });
});

describe("describeActivity — trades", () => {
  it("reads a CLOB buy as cash leaving the account", () => {
    const entry = describeActivity(
      activity({
        type: "TRADE",
        side: "BUY",
        shares: 12,
        amount: 6.48,
        price: 0.54,
        title: "Will X happen?",
        icon: "https://example.test/x.png",
        outcome: "Yes",
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
      activity({ type: "TRADE", side: "SELL", shares: 5, amount: 3.1, price: 0.62, outcome: "No" }),
    );

    expect(entry.label).toBe("Sold");
    expect(entry.direction).toBe("in");
    expect(entry.side).toBe("SELL");
  });

  it("links a CLOB trade by event slug", () => {
    // The detail route resolves event slugs; a market slug 404s.
    const entry = describeActivity(activity({ type: "TRADE", side: "BUY", eventSlug: "event-slug" }));
    expect(entry.eventSlug).toBe("event-slug");
  });

  it("leaves a combo trade unlinked and without an outcome label", () => {
    const entry = describeActivity(
      activity({
        type: "TRADE",
        isCombo: true,
        side: "BUY",
        shares: 3,
        amount: 1.5,
        price: 0.5,
        title: "Some combo",
        eventSlug: "would-not-resolve",
        outcome: "Yes",
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
    const split = describeActivity(activity({ type: "SPLIT", amount: 20, title: "M", eventSlug: "e" }));
    const merge = describeActivity(activity({ type: "MERGE", amount: 20, title: "M", eventSlug: "e" }));

    expect(split.label).toBe("Split");
    expect(split.direction).toBe("out");
    expect(merge.label).toBe("Merged");
    expect(merge.direction).toBe("in");
    expect(split.kind).toBe("settlement");
  });

  it("reads a redemption as proceeds arriving", () => {
    const entry = describeActivity(
      activity({ type: "REDEEM", amount: 14.75, title: "Resolved market", eventSlug: "resolved-market" }),
    );

    expect(entry.label).toBe("Redeemed");
    expect(entry.direction).toBe("in");
    expect(entry.amount).toBe(14.75);
    expect(entry.eventSlug).toBe("resolved-market");
  });

  it("renders a conversion unsigned rather than guessing which way it moved", () => {
    const entry = describeActivity(activity({ type: "CONVERSION", amount: 8, title: "M" }));

    expect(entry.label).toBe("Converted");
    expect(entry.direction).toBe("neutral");
    expect(entry.amount).toBe(8);
  });

  // the old fall-through-to-trade default would have shown this as "Bought"
  it("renders an unknown type neutrally under its own name, never as a trade", () => {
    const entry = describeActivity(
      activity({ type: "DIRECTIONAL_SPLIT", side: "BUY", amount: 4, title: "M" }),
    );

    expect(entry.kind).toBe("settlement");
    expect(entry.label).toBe("Directional split");
    expect(entry.direction).toBe("neutral");
    expect(entry.side).toBeNull();
  });
});

describe("describeActivity — account credits", () => {
  it.each([
    ["REWARD", "Reward"],
    ["MAKER_REBATE", "Maker rebate"],
    ["TAKER_REBATE", "Taker rebate"],
    ["REFERRAL_REWARD", "Referral reward"],
    ["YIELD", "Yield"],
  ])("reads %s as an incoming credit with no market attached", (type, label) => {
    const entry = describeActivity(activity({ type, amount: 0.42, title: "leaked", eventSlug: "leaked" }));

    expect(entry.kind).toBe("credit");
    expect(entry.label).toBe(label);
    expect(entry.direction).toBe("in");
    expect(entry.amount).toBe(0.42);
    expect(entry.title).toBeNull();
    expect(entry.eventSlug).toBeNull();
    expect(entry.icon).toBeNull();
    expect(entry.side).toBeNull();
    expect(entry.shares).toBeNull();
  });

  it("carries the timestamp and transaction hash through", () => {
    const entry = describeActivity(
      activity({ type: "YIELD", amount: 1, timestamp: 1_699_999_999_000, transactionHash: "0xdeadbeef" }),
    );

    expect(entry.timestamp).toBe(1_699_999_999_000);
    expect(entry.transactionHash).toBe("0xdeadbeef");
  });
});

describe("describeActivityList", () => {
  it("gives colliding rows in one transaction distinct keys", () => {
    // Rows have no id, and one transaction can emit several identical-looking
    // fills. Without the occurrence counter React would drop all but one.
    const fill = activity({ type: "TRADE", side: "BUY", shares: 1, amount: 1, price: 1, transactionHash: "0xsame" });
    const entries = describeActivityList([fill, { ...fill }]);

    expect(entries).toHaveLength(2);
    expect(entries[0].key).not.toBe(entries[1].key);
  });

  it("separates different activity types sharing one transaction hash", () => {
    const entries = describeActivityList([
      activity({ type: "REDEEM", amount: 5, transactionHash: "0xsame" }),
      activity({ type: "REWARD", amount: 5, transactionHash: "0xsame" }),
    ]);

    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
  });

  it("preserves input order", () => {
    const entries = describeActivityList([
      activity({ type: "REWARD", amount: 1 }),
      activity({ type: "YIELD", amount: 2 }),
    ]);

    expect(entries.map((e) => e.label)).toEqual(["Reward", "Yield"]);
  });

  it("returns nothing for an empty feed", () => {
    expect(describeActivityList([])).toEqual([]);
  });
});

describe("fetchActivityPage", () => {
  const WALLET = "0x2ecb3055976168e95676dc12c10e2000e2d9ecb8";
  const client = { account: { wallet: WALLET } } as unknown as BrowserClient;

  type FetchSignature = (input: string | URL, init?: RequestInit) => Promise<Response>;
  const mockFetch = (body: unknown, status = 200) => {
    const fetchMock = vi.fn<FetchSignature>(
      async () => new Response(JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks /v2/activity for the deposit wallet, newest first, without offset", async () => {
    const fetchMock = mockFetch({
      data: [v2Trade],
      pagination: { limit: 25, has_more: true, next_cursor: "abc" },
    });

    const page = await fetchActivityPage(client);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/activity");
    expect(url.searchParams.get("user")).toBe(WALLET);
    expect(url.searchParams.get("sort_by")).toBe("TIMESTAMP");
    expect(url.searchParams.get("sort_direction")).toBe("DESC");
    expect(url.searchParams.get("exclude_deposits_withdrawals")).toBe("true");
    expect(url.searchParams.has("offset")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("abc");
    expect(page.hasMore).toBe(true);
  });

  it("passes the cursor back with the same filters", async () => {
    const fetchMock = mockFetch({ data: [], pagination: { has_more: false, next_cursor: null } });

    const page = await fetchActivityPage(client, "abc");

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.get("exclude_deposits_withdrawals")).toBe("true");
    expect(page.nextCursor).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });

  // an outage must read as an error, never as "no activity"
  it("throws on the v1 retirement 410 rather than returning an empty page", async () => {
    mockFetch({ error: "Data API v1 has been retired" }, 410);
    await expect(fetchActivityPage(client)).rejects.toThrow("410");
  });
});
