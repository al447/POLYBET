import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLeaderboard } from "./leaderboard";

/**
 * Fixtures copied verbatim from a real
 * `data-api.polymarket.com/v1/leaderboard?timePeriod=WEEK&orderBy=PNL`
 * response on 2026-08-17 (values shortened, shapes untouched). Each row here
 * is a quirk that was actually observed, not an invented edge case:
 *
 *   - `rank` is a string on every row
 *   - `profileImage` is empty on 47 of 50 rows
 *   - `vol` is genuinely 0 for several top-PnL traders
 *   - `userName` is sometimes empty, sometimes `0x…-<timestamp>`
 */
const fixtureRows = [
  {
    rank: "1",
    proxyWallet: "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8",
    userName: "WTSA",
    xUsername: "",
    verifiedBadge: false,
    vol: 2339052.0,
    pnl: 287429.0329031234,
    profileImage: "",
  },
  {
    rank: "2",
    proxyWallet: "0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf",
    userName: "0x3DFb153c197D4C19D3B31c1ecD2c7B6860eeabAf-1722957908185",
    xUsername: "",
    verifiedBadge: false,
    vol: 3557231.0,
    pnl: 138702.5,
    profileImage: "",
  },
  {
    rank: "3",
    proxyWallet: "0x4ab9000000000000000000000000000000008ebe",
    userName: "RWCS",
    xUsername: "",
    verifiedBadge: true,
    vol: 0,
    pnl: 102266.87,
    profileImage: "https://polymarket-upload.s3.us-east-2.amazonaws.com/profile.png",
  },
];

const mockFetchOnce = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

/**
 * The same stub, but handed back so a test can read the URL it was called with.
 *
 * The call signature is supplied as a generic rather than inferred: an
 * implementation written `async () => …` declares no parameters, so `Mock`
 * infers an empty argument tuple and `mock.calls[0][0]` has nothing to index —
 * a type error under `strict`, even though the real call does receive a URL.
 */
type FetchSignature = (input: string | URL, init?: RequestInit) => Promise<Response>;

const mockFetchCapturing = (body: unknown, status = 200) => {
  const fetchMock = vi.fn<FetchSignature>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLeaderboard", () => {
  it("normalises the wire shape, including the string rank", async () => {
    mockFetchOnce(fixtureRows);

    const traders = await fetchLeaderboard({ periodId: "1w", orderingId: "pnl", limit: 3 });

    expect(traders).toHaveLength(3);
    expect(traders[0]).toEqual({
      rank: 1,
      address: "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8",
      name: "WTSA",
      avatar: undefined,
      verified: false,
      pnl: 287429.0329031234,
      volume: 2339052.0,
    });
  });

  it("replaces an address-shaped username with a shortened address", async () => {
    mockFetchOnce(fixtureRows);

    const traders = await fetchLeaderboard();

    expect(traders[1].name).toBe("0x3dfb…abaf");
  });

  it("keeps rows whose volume is genuinely zero", async () => {
    mockFetchOnce(fixtureRows);

    const traders = await fetchLeaderboard();

    expect(traders[2].volume).toBe(0);
    expect(traders[2].pnl).toBe(102266.87);
  });

  it("carries a present profile image through and drops an empty one", async () => {
    mockFetchOnce(fixtureRows);

    const traders = await fetchLeaderboard();

    expect(traders[0].avatar).toBeUndefined();
    expect(traders[2].avatar).toBe(
      "https://polymarket-upload.s3.us-east-2.amazonaws.com/profile.png",
    );
    expect(traders[2].verified).toBe(true);
  });

  /**
   * 🚩 The regression this exists to catch: `window` is not a parameter on
   * this endpoint. Sending it instead of `timePeriod` returns a clean 200 of
   * the DAY board, so a "this week" page would silently show today's numbers.
   */
  it("sends timePeriod and orderBy, resolved from ids", async () => {
    const fetchMock = mockFetchCapturing([]);

    await fetchLeaderboard({ periodId: "1m", orderingId: "volume", limit: 10 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1/leaderboard");
    expect(url.searchParams.get("timePeriod")).toBe("MONTH");
    expect(url.searchParams.get("orderBy")).toBe("VOL");
    expect(url.searchParams.get("window")).toBeNull();
  });

  it("clamps limit to the API's own ceiling of 50", async () => {
    const fetchMock = mockFetchCapturing([]);

    await fetchLeaderboard({ limit: 500 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("skips rows with no wallet address rather than rendering a nameless entry", async () => {
    mockFetchOnce([{ rank: "1", userName: "ghost", pnl: 10, vol: 10 }, fixtureRows[0]]);

    const traders = await fetchLeaderboard();

    expect(traders).toHaveLength(1);
    expect(traders[0].name).toBe("WTSA");
  });

  it("falls back to offset-aware positions when rank is missing", async () => {
    mockFetchOnce([{ proxyWallet: "0xabc0000000000000000000000000000000000001", pnl: 1, vol: 1 }]);

    const traders = await fetchLeaderboard({ offset: 25 });

    expect(traders[0].rank).toBe(26);
  });

  it("returns an empty list rather than throwing on an upstream failure", async () => {
    mockFetchOnce({ error: "boom" }, 500);

    await expect(fetchLeaderboard()).resolves.toEqual([]);
  });

  it("returns an empty list when the body is not an array", async () => {
    mockFetchOnce({ traders: [] });

    await expect(fetchLeaderboard()).resolves.toEqual([]);
  });
});
