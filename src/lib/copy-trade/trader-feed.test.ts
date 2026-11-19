import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTraderPositionSizes,
  fetchTraderTrades,
  parseTraderPositionSizes,
  parseTraderTrades,
} from "./trader-feed";

/**
 * Fixtures follow the Data API v2 row shape captured live 2026-11-19 from
 * `/v2/trades?user=…` and `/v2/positions?user=…` — snake_case, inside a
 * `{ data, pagination }` envelope. Values are from an earlier real trade.
 */
const WTSA = "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8";

const tradeRow = {
  proxy_wallet: "0x04d5524A0a5AF2eCa6E39E03dEfC261d42fe66d8", // mixed case on the wire
  side: "BUY",
  token_id: "64921565804805286134965518961016995720099848599334924149956356624078303095123",
  condition_id: "0xf43f26d689db1915c955fcc219666c011d4d8a640ddab0849f360a6a1928dd0d",
  size: 38132.38,
  price: 0.3234694976,
  timestamp: 1786932886,
  title: "Will Club Tijuana win on 2026-08-16?",
  slug: "mex-tij-caz-2026-08-16-tij",
  icon: "https://polymarket-upload.s3.us-east-2.amazonaws.com/mex.png",
  event_slug: "mex-tij-caz-2026-08-16",
  outcome: "Yes",
  outcome_index: 0,
  name: "WTSA",
  pseudonym: "Foolhardy-Essence",
  bio: "",
  profile_image: "",
  profile_image_optimized: "",
  transaction_hash: "0xcf987ecce63294d79db9136ff3ea2e23229b47ef354378f2a14e34ccbab659d9",
};

const page = (rows: unknown[]) => ({
  data: rows,
  pagination: { limit: rows.length, offset: 0, has_more: false, next_cursor: null },
});

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
    const [trade] = parseTraderTrades(page([tradeRow]), WTSA);

    // `token_id` → `tokenId` is the rename that matters: it is what
    // `placeMarketBuy` takes, and `condition_id` is the easy wrong answer.
    expect(trade.tokenId).toBe(tradeRow.token_id);
    expect(trade.conditionId).toBe(tradeRow.condition_id);
    expect(trade.eventSlug).toBe(tradeRow.event_slug);
    expect(trade.transactionHash).toBe(tradeRow.transaction_hash);
    expect(trade.address).toBe(WTSA);
    expect(trade.side).toBe("BUY");
    expect(trade.size).toBe(38132.38);
    expect(trade.price).toBe(0.3234694976);
    expect(trade.timestamp).toBe(1786932886);
  });

  it("lowercases the address so it matches the follow list's key", () => {
    const [trade] = parseTraderTrades(page([tradeRow]), WTSA);
    expect(trade.address).toBe(trade.address.toLowerCase());
  });

  it("falls back to the requested address when the row omits one", () => {
    const [trade] = parseTraderTrades(page([{ ...tradeRow, proxy_wallet: undefined }]), WTSA);
    expect(trade.address).toBe(WTSA);
  });

  it("drops rows that could never be mirrored", () => {
    const trades = parseTraderTrades(
      page([
        { ...tradeRow, token_id: "" }, // no token to buy
        { ...tradeRow, side: "" }, // a REDEEM row's shape
        { ...tradeRow, side: "MERGE" },
      ]),
      WTSA,
    );
    expect(trades).toEqual([]);
  });

  it("accepts a lowercase side", () => {
    const [trade] = parseTraderTrades(page([{ ...tradeRow, side: "sell" }]), WTSA);
    expect(trade.side).toBe("SELL");
  });

  it("coerces stringified numbers and never yields NaN", () => {
    const [trade] = parseTraderTrades(
      page([{ ...tradeRow, size: "38132.38", price: "0.32", timestamp: "1786932886" }]),
      WTSA,
    );
    expect(trade.size).toBe(38132.38);
    expect(trade.price).toBe(0.32);
    expect(trade.timestamp).toBe(1786932886);

    const [bad] = parseTraderTrades(page([{ ...tradeRow, size: null, price: "abc" }]), WTSA);
    expect(bad.size).toBe(0);
    expect(bad.price).toBe(0);
  });

  it("survives a payload with no data array", () => {
    expect(parseTraderTrades(null, WTSA)).toEqual([]);
    expect(parseTraderTrades({ error: "nope" }, WTSA)).toEqual([]);
    expect(parseTraderTrades({ data: null }, WTSA)).toEqual([]);
    expect(parseTraderTrades(page([null, 7, "x"]), WTSA)).toEqual([]);
  });

  it("reads nothing from a bare v1-style array", () => {
    expect(parseTraderTrades([tradeRow], WTSA)).toEqual([]);
  });
});

describe("parseTraderPositionSizes", () => {
  const positionRow = {
    proxy_wallet: WTSA,
    token_id: "30075873981656958960154378128094969261254626646997033445258994571576123324361",
    condition_id: "0xbc5131b0660246ffe7039191f89c356facfbe2984e3021f97db7e48d9b4a8e40",
    current_size: 279998.1319,
    total_size: 412000.5,
    avg_price: 0.5063,
    current_value: 0,
    title: "Will St. Louis City SC win on 2026-08-01?",
    outcome: "Yes",
    status: "REDEEMABLE",
    redeemable: true,
  };

  it("maps token id to the current share count", () => {
    const sizes = parseTraderPositionSizes(page([positionRow]));
    expect(sizes.get(positionRow.token_id)).toBe(279998.1319);
  });

  // total_size is lifetime bought, so using it would hide every exit
  it("omits sold-out positions even while total_size is still set", () => {
    const sizes = parseTraderPositionSizes(page([{ ...positionRow, current_size: 0 }]));
    expect(sizes.size).toBe(0);
  });

  it("survives a payload with no data array", () => {
    expect(parseTraderPositionSizes(null).size).toBe(0);
    expect(parseTraderPositionSizes({}).size).toBe(0);
    expect(parseTraderPositionSizes([positionRow]).size).toBe(0);
  });
});

describe("fetchTraderTrades", () => {
  it("asks for the trader by address", async () => {
    const fetchMock = mockFetch(page([tradeRow]));

    const trades = await fetchTraderTrades(WTSA, { limit: 100 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/trades");
    expect(url.searchParams.get("user")).toBe(WTSA);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.has("offset")).toBe(false);
    expect(trades).toHaveLength(1);
  });

  it("returns an empty list on the v1 retirement 410", async () => {
    mockFetch({ error: "Data API v1 has been retired" }, 410);
    await expect(fetchTraderTrades(WTSA)).resolves.toEqual([]);
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
  it("asks /v2/positions for the trader by address", async () => {
    const fetchMock = mockFetch(page([]));

    await fetchTraderPositionSizes(WTSA);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/positions");
    expect(url.searchParams.get("user")).toBe(WTSA);
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("returns an empty map on failure, which decideCopy reads as a full exit", async () => {
    // The safe direction: over-exiting costs upside, under-exiting leaves a
    // position the user believes they closed.
    mockFetch({ error: "boom" }, 500);
    const sizes = await fetchTraderPositionSizes(WTSA);
    expect(sizes.size).toBe(0);
  });
});
