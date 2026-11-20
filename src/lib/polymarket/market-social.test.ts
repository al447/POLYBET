import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMarketTrades, fetchTopHolders } from "./market-social";

/** v2 rows captured live 2026-11-19 on one binary market (ids shortened). */
const CONDITION = "0x4c3844f8716850ebdad01ff02ca7cf798a99e99c468d6bdd1aff19b42dd56401";

const holder = (overrides: Record<string, unknown>) => ({
  proxy_wallet: "0x24207017ddb84ea72779f98f27eca522d0a67ed8",
  bio: "",
  token_id: "8995928971",
  pseudonym: "Annual-Burning",
  amount: 110503.58289,
  display_username_public: true,
  outcome_index: 0,
  name: "Ifan",
  profile_image: "",
  profile_image_optimized: "",
  verified: false,
  ...overrides,
});

const holdersBody = {
  data: [
    { token_id: "8995928971", holders: [holder({})] },
    {
      token_id: "5439237269",
      holders: [
        holder({
          proxy_wallet: "0xa5ef39c3d3e10d0b270233af41cac69796b12966",
          pseudonym: "Rapid-Alphabet-Winner",
          amount: 193521.457085,
          display_username_public: false,
          outcome_index: 1,
          name: "rw0ajdugzw",
          profile_image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/p.png",
        }),
      ],
    },
  ],
  pagination: { limit: 1, has_more: true, next_cursor: "abc" },
};

const trade = (overrides: Record<string, unknown>) => ({
  proxy_wallet: "0x2ecb3055976168e95676dc12c10e2000e2d9ecb8",
  side: "BUY",
  token_id: "5439237269",
  condition_id: CONDITION,
  size: 3499.47,
  price: 0.957,
  timestamp: 1795081472,
  title: "Will Tim Cook be the next CEO of NVIDIA?",
  outcome: "No",
  outcome_index: 1,
  name: "DrSlips",
  pseudonym: "Remorseful-Purchase",
  profile_image: "",
  transaction_hash: "0xa6111c71",
  ...overrides,
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

describe("fetchTopHolders", () => {
  it("asks /v2/holders by condition, never by the retired market param", async () => {
    const fetchMock = mockFetch(holdersBody);

    await fetchTopHolders(CONDITION, 5);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/holders");
    expect(url.searchParams.get("condition")).toBe(CONDITION);
    expect(url.searchParams.has("market")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("flattens both sides and sorts by size across the whole market", async () => {
    mockFetch(holdersBody);

    const holders = await fetchTopHolders(CONDITION);

    expect(holders.map((h) => h.outcomeIndex)).toEqual([1, 0]);
    expect(holders[0]).toEqual({
      address: "0xa5ef39c3d3e10d0b270233af41cac69796b12966",
      name: "Rapid-Alphabet-Winner",
      avatar: "https://polymarket-upload.s3.us-east-2.amazonaws.com/p.png",
      shares: 193521.457085,
      outcomeIndex: 1,
    });
  });

  it("respects display_username_public, falling back to the pseudonym", async () => {
    mockFetch(holdersBody);

    const holders = await fetchTopHolders(CONDITION);

    expect(holders.find((h) => h.outcomeIndex === 1)?.name).toBe("Rapid-Alphabet-Winner");
    expect(holders.find((h) => h.outcomeIndex === 0)?.name).toBe("Ifan");
  });

  it("returns an empty list on the v1 retirement 410", async () => {
    mockFetch({ error: "Data API v1 has been retired" }, 410);
    await expect(fetchTopHolders(CONDITION)).resolves.toEqual([]);
  });

  it("returns an empty list on a bare v1-style array", async () => {
    mockFetch(holdersBody.data);
    await expect(fetchTopHolders(CONDITION)).resolves.toEqual([]);
  });
});

describe("fetchMarketTrades", () => {
  it("asks /v2/trades by condition", async () => {
    const fetchMock = mockFetch({ data: [], pagination: {} });

    await fetchMarketTrades(CONDITION, 20);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/trades");
    expect(url.searchParams.get("condition")).toBe(CONDITION);
    expect(url.searchParams.has("market")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("normalises v2 rows, newest first", async () => {
    mockFetch({
      data: [trade({ timestamp: 1795081472 }), trade({ timestamp: 1795084510, side: "SELL" })],
      pagination: {},
    });

    const trades = await fetchMarketTrades(CONDITION);

    expect(trades.map((t) => t.timestamp)).toEqual([1795084510, 1795081472]);
    expect(trades[1]).toMatchObject({
      address: "0x2ecb3055976168e95676dc12c10e2000e2d9ecb8",
      name: "DrSlips",
      side: "BUY",
      outcome: "No",
      shares: 3499.47,
      price: 0.957,
      transactionHash: "0xa6111c71",
    });
    expect(trades[0].side).toBe("SELL");
  });

  it("gives fills sharing one transaction distinct keys", async () => {
    mockFetch({ data: [trade({}), trade({})], pagination: {} });

    const trades = await fetchMarketTrades(CONDITION);

    expect(new Set(trades.map((t) => t.key)).size).toBe(2);
  });

  it("returns an empty list on the v1 retirement 410", async () => {
    mockFetch({ error: "Data API v1 has been retired" }, 410);
    await expect(fetchMarketTrades(CONDITION)).resolves.toEqual([]);
  });
});
