import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLeaderboard } from "./leaderboard";

/**
 * Rows in the Data API v2 shape, captured from a real
 * `data-api.polymarket.com/v2/leaderboard?time_period=week&sort_by=PNL`
 * response on 2026-11-19 (values shortened, shapes untouched). The quirks are
 * real ones, not invented edge cases:
 *
 *   - `profile_image` is empty on most rows
 *   - `volume` is genuinely 0 for some top-PnL traders
 *   - `user_name` is sometimes empty, sometimes `0x…-<timestamp>`
 */
const fixtureRows = [
  {
    rank: 1,
    user_id: "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8",
    user_name: "WTSA",
    x_username: "",
    verified: false,
    volume: 2339052.0,
    pnl: 287429.0329031234,
    profile_image: "",
  },
  {
    rank: 2,
    user_id: "0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf",
    user_name: "0x3DFb153c197D4C19D3B31c1ecD2c7B6860eeabAf-1722957908185",
    x_username: "",
    verified: false,
    volume: 3557231.0,
    pnl: 138702.5,
    profile_image: "",
  },
  {
    rank: 3,
    user_id: "0x4ab9000000000000000000000000000000008ebe",
    user_name: "RWCS",
    x_username: "",
    verified: true,
    volume: 0,
    pnl: 102266.87,
    profile_image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/profile.png",
  },
];

/** v2 wraps every payload in `data`, paginated routes add `pagination`. */
const page = (rows: unknown[]) => ({
  data: rows,
  pagination: { limit: rows.length, offset: 0, has_more: false, next_cursor: null },
});

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
  it("normalises the v2 wire shape", async () => {
    mockFetchOnce(page(fixtureRows));

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
    mockFetchOnce(page(fixtureRows));

    const traders = await fetchLeaderboard();

    expect(traders[1].name).toBe("0x3dfb…abaf");
  });

  it("keeps rows whose volume is genuinely zero", async () => {
    mockFetchOnce(page(fixtureRows));

    const traders = await fetchLeaderboard();

    expect(traders[2].volume).toBe(0);
    expect(traders[2].pnl).toBe(102266.87);
  });

  it("carries a present profile image through and drops an empty one", async () => {
    mockFetchOnce(page(fixtureRows));

    const traders = await fetchLeaderboard();

    expect(traders[0].avatar).toBeUndefined();
    expect(traders[2].avatar).toBe(
      "https://polymarket-upload.s3.us-east-2.amazonaws.com/profile.png",
    );
    expect(traders[2].verified).toBe(true);
  });

  /**
   * 🚩 The regression this exists to catch: `window` is not a parameter on
   * this endpoint. Sending it instead of `time_period` returns a clean 200 of
   * the day board, so a "this week" page would silently show today's numbers.
   */
  it("sends time_period and sort_by, resolved from ids", async () => {
    const fetchMock = mockFetchCapturing(page([]));

    await fetchLeaderboard({ periodId: "1m", orderingId: "volume", limit: 10 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/leaderboard");
    expect(url.searchParams.get("time_period")).toBe("month");
    expect(url.searchParams.get("sort_by")).toBe("VOLUME");
    expect(url.searchParams.get("window")).toBeNull();
  });

  // v2 400s on any offset, including 0.
  it("never sends offset", async () => {
    const fetchMock = mockFetchCapturing(page([]));

    await fetchLeaderboard();

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("clamps limit to our page cap of 50", async () => {
    const fetchMock = mockFetchCapturing(page([]));

    await fetchLeaderboard({ limit: 500 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("skips rows with no wallet address rather than rendering a nameless entry", async () => {
    mockFetchOnce(page([{ rank: 1, user_name: "ghost", pnl: 10, volume: 10 }, fixtureRows[0]]));

    const traders = await fetchLeaderboard();

    expect(traders).toHaveLength(1);
    expect(traders[0].name).toBe("WTSA");
  });

  it("falls back to position-in-page when rank is missing", async () => {
    mockFetchOnce(page([{ user_id: "0xabc0000000000000000000000000000000000001", pnl: 1, volume: 1 }]));

    const traders = await fetchLeaderboard();

    expect(traders[0].rank).toBe(1);
  });

  it("returns an empty list rather than throwing on an upstream failure", async () => {
    mockFetchOnce({ error: "boom" }, 500);

    await expect(fetchLeaderboard()).resolves.toEqual([]);
  });

  it("returns an empty list when the body is not an array", async () => {
    mockFetchOnce({ traders: [] });

    await expect(fetchLeaderboard()).resolves.toEqual([]);
  });

  // The exact shape that took the board down: v1 retired on 2026-11-02.
  it("returns an empty list on the v1 retirement 410", async () => {
    mockFetchOnce({ error: "Data API v1 has been retired" }, 410);

    await expect(fetchLeaderboard()).resolves.toEqual([]);
  });
});
