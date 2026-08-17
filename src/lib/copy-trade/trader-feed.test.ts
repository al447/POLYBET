import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTraderPositionSizes,
  fetchTraderTrades,
  parseTraderPositionSizes,
  parseTraderTrades,
} from "./trader-feed";

/**
 * Fixtures are verbatim rows from `data-api.polymarket.com` on 2026-08-17 —
 * `/trades?user=0x04d5…66d8` and `/positions?user=…`. Field names and casing
 * are untouched; only the long ids are shortened.
 */
const WTSA = "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8";

const tradeRow = {
  proxyWallet: "0x04d5524A0a5AF2eCa6E39E03dEfC261d42fe66d8", // mixed case on the wire
  side: "BUY",
  asset: "64921565804805286134965518961016995720099848599334924149956356624078303095123",
  conditionId: "0xf43f26d689db1915c955fcc219666c011d4d8a640ddab0849f360a6a1928dd0d",
  size: 38132.38,
  price: 0.3234694976,
  timestamp: 1786932886,
  title: "Will Club Tijuana win on 2026-08-16?",
  slug: "mex-tij-caz-2026-08-16-tij",
  icon: "https://polymarket-upload.s3.us-east-2.amazonaws.com/mex.png",
  eventSlug: "mex-tij-caz-2026-08-16",
  outcome: "Yes",
  outcomeIndex: 0,
  name: "WTSA",
  pseudonym: "Foolhardy-Essence",
  bio: "",
  profileImage: "",
  profileImageOptimized: "",
  transactionHash: "0xcf987ecce63294d79db9136ff3ea2e23229b47ef354378f2a14e34ccbab659d9",
};

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

describe("parseTraderTrades", () => {
  it("renames the wire fields to the ones the order call sites use", () => {
    const [trade] = parseTraderTrades([tradeRow], WTSA);

    // `asset` → `tokenId` is the rename that matters: it is what
    // `placeMarketBuy` takes, and `conditionId` is the easy wrong answer.
    expect(trade.tokenId).toBe(tradeRow.asset);
    expect(trade.conditionId).toBe(tradeRow.conditionId);
    expect(trade.address).toBe(WTSA);
    expect(trade.side).toBe("BUY");
    expect(trade.size).toBe(38132.38);
    expect(trade.price).toBe(0.3234694976);
    expect(trade.timestamp).toBe(1786932886);
  });

  it("lowercases the address so it matches the follow list's key", () => {
    const [trade] = parseTraderTrades([tradeRow], WTSA);
    expect(trade.address).toBe(trade.address.toLowerCase());
  });

  it("falls back to the requested address when the row omits one", () => {
    const [trade] = parseTraderTrades([{ ...tradeRow, proxyWallet: undefined }], WTSA);
    expect(trade.address).toBe(WTSA);
  });

  it("drops rows that could never be mirrored", () => {
    const trades = parseTraderTrades(
      [
        { ...tradeRow, asset: "" }, // no token to buy
        { ...tradeRow, side: "" }, // a REDEEM row's shape
        { ...tradeRow, side: "MERGE" },
      ],
      WTSA,
    );
    expect(trades).toEqual([]);
  });

  it("accepts a lowercase side", () => {
    const [trade] = parseTraderTrades([{ ...tradeRow, side: "sell" }], WTSA);
    expect(trade.side).toBe("SELL");
  });

  it("coerces stringified numbers and never yields NaN", () => {
    const [trade] = parseTraderTrades(
      [{ ...tradeRow, size: "38132.38", price: "0.32", timestamp: "1786932886" }],
      WTSA,
    );
    expect(trade.size).toBe(38132.38);
    expect(trade.price).toBe(0.32);
    expect(trade.timestamp).toBe(1786932886);

    const [bad] = parseTraderTrades([{ ...tradeRow, size: null, price: "abc" }], WTSA);
    expect(bad.size).toBe(0);
    expect(bad.price).toBe(0);
  });

  it("survives a non-array payload", () => {
    expect(parseTraderTrades(null, WTSA)).toEqual([]);
    expect(parseTraderTrades({ error: "nope" }, WTSA)).toEqual([]);
    expect(parseTraderTrades([null, 7, "x"], WTSA)).toEqual([]);
  });
});

describe("parseTraderPositionSizes", () => {
  const positionRow = {
    asset: "30075873981656958960154378128094969261254626646997033445258994571576123324361",
    conditionId: "0xbc5131b0660246ffe7039191f89c356facfbe2984e3021f97db7e48d9b4a8e40",
    size: 279998.1319,
    avgPrice: 0.5063,
    currentValue: 0,
    title: "Will St. Louis City SC win on 2026-08-01?",
    outcome: "Yes",
    redeemable: true,
  };

  it("maps token id to share count", () => {
    const sizes = parseTraderPositionSizes([positionRow]);
    expect(sizes.get(positionRow.asset)).toBe(279998.1319);
  });

  it("omits closed positions so an exit reads them as zero held", () => {
    const sizes = parseTraderPositionSizes([{ ...positionRow, size: 0 }]);
    expect(sizes.size).toBe(0);
  });

  it("survives a non-array payload", () => {
    expect(parseTraderPositionSizes(null).size).toBe(0);
    expect(parseTraderPositionSizes({}).size).toBe(0);
  });
});

describe("fetchTraderTrades", () => {
  it("asks for the trader by address", async () => {
    const fetchMock = mockFetch([tradeRow]);

    const trades = await fetchTraderTrades(WTSA, { limit: 100 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/trades");
    expect(url.searchParams.get("user")).toBe(WTSA);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(trades).toHaveLength(1);
  });

  it("returns an empty list on an error status rather than throwing", async () => {
    // One trader's outage must not stop the poll for every other trader.
    mockFetch({ error: "boom" }, 500);
    await expect(fetchTraderTrades(WTSA)).resolves.toEqual([]);
  });

  it("returns an empty list when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchTraderTrades(WTSA)).resolves.toEqual([]);
  });
});

describe("fetchTraderPositionSizes", () => {
  it("returns an empty map on failure, which decideCopy reads as a full exit", async () => {
    // The safe direction: over-exiting costs upside, under-exiting leaves a
    // position the user believes they closed.
    mockFetch({ error: "boom" }, 500);
    const sizes = await fetchTraderPositionSizes(WTSA);
    expect(sizes.size).toBe(0);
  });
});
