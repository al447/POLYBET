import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserClient } from "./browser-client";
import {
  listPortfolioPositions,
  parsePortfolioPositions,
  summarizePositions,
  type PortfolioPosition,
} from "./portfolio";

/**
 * A `/v2/positions` row captured live 2026-11-19 (ids shortened, values and
 * shape untouched). Its own identities hold, which the mapping relies on:
 * `current_value − entry_cost_usdc = unrealized_pnl`.
 */
const v2Row = {
  proxy_wallet: "0x2ecb3055976168e95676dc12c10e2000e2d9ecb8",
  token_id: "1235542575596688477313848611478957797754574132778744552334368030605653599770",
  condition_id: "0xfe28d93c0729d1e099a0359caaf1277e4e6560034c2e3900d65921515f467282",
  current_size: 44438.1032,
  avg_price: 0.8573,
  entry_cost_usdc: 38098.7887,
  entry_fees_usdc: 19.194052,
  total_cost_usdc: 38117.982752,
  current_price: 0.8945,
  current_value: 39749.8833,
  total_size: 97063.1261,
  realized_pnl: 2368.8066,
  unrealized_pnl: 1651.0945,
  total_pnl: 4019.9011,
  percent_pnl: 4.3337,
  status: "OPEN",
  redeemable: false,
  mergeable: false,
  title: "Will there be no new CEO of NVIDIA by December 31, 2028?",
  slug: "will-candidate-a-be-the-next-ceo-of-nvidia",
  icon: "https://polymarket-upload.s3.us-east-2.amazonaws.com/nvidia.png",
  event_slug: "next-ceo-of-nvidia",
  outcome: "Yes",
};

describe("parsePortfolioPositions", () => {
  it("maps a v2 row onto the field names the components read", () => {
    const [position] = parsePortfolioPositions([v2Row]);

    expect(position).toEqual({
      tokenId: v2Row.token_id,
      conditionId: v2Row.condition_id,
      title: v2Row.title,
      icon: v2Row.icon,
      eventSlug: "next-ceo-of-nvidia",
      outcome: "Yes",
      size: 44438.1032,
      avgPrice: 0.8573,
      curPrice: 0.8945,
      currentValue: 39749.8833,
      initialValue: 38098.7887,
      cashPnl: 1651.0945,
      percentPnl: 4.3337,
      realizedPnl: 2368.8066,
      redeemable: false,
    });
  });

  // total_size is lifetime bought; reading it would overstate every holding
  it("reads current_size as the holding, never total_size", () => {
    const [position] = parsePortfolioPositions([v2Row]);
    expect(position.size).toBe(v2Row.current_size);
  });

  it("uses fee-exclusive entry cost, so fees are never deducted twice", () => {
    const [position] = parsePortfolioPositions([v2Row]);
    expect(position.initialValue).toBe(v2Row.entry_cost_usdc);
    expect(position.currentValue - position.initialValue).toBeCloseTo(position.cashPnl, 3);
  });

  it("drops rows with no token id or no shares held", () => {
    expect(
      parsePortfolioPositions([
        { ...v2Row, token_id: "" },
        { ...v2Row, current_size: 0 },
        null,
        "x",
      ]),
    ).toEqual([]);
  });

  it("reads empty strings as null so the UI's fallbacks still apply", () => {
    const [position] = parsePortfolioPositions([
      { ...v2Row, title: "", icon: "", event_slug: "", outcome: "" },
    ]);
    expect(position.title).toBeNull();
    expect(position.icon).toBeNull();
    expect(position.eventSlug).toBeNull();
    expect(position.outcome).toBeNull();
  });

  it("coerces missing or unparseable money fields to zero, never NaN", () => {
    const [position] = parsePortfolioPositions([
      { token_id: "tok", current_size: "5", current_value: "abc", percent_pnl: null },
    ]);
    expect(position.size).toBe(5);
    expect(position.currentValue).toBe(0);
    expect(position.cashPnl).toBe(0);
    expect(position.percentPnl).toBeNull();
  });

  it("keeps a resolved position, which redeem.ts needs to see", () => {
    const [position] = parsePortfolioPositions([{ ...v2Row, status: "REDEEMABLE", redeemable: true }]);
    expect(position.redeemable).toBe(true);
  });
});

function position(fields: Partial<PortfolioPosition>): PortfolioPosition {
  return {
    tokenId: "tok",
    conditionId: "0xc",
    title: null,
    icon: null,
    eventSlug: null,
    outcome: null,
    size: 1,
    avgPrice: 0,
    curPrice: 0,
    currentValue: 0,
    initialValue: 0,
    cashPnl: 0,
    percentPnl: null,
    realizedPnl: 0,
    redeemable: false,
    ...fields,
  };
}

describe("summarizePositions", () => {
  it("sums value, cost, and both PnL figures across positions", () => {
    const summary = summarizePositions([
      position({ currentValue: 60, initialValue: 50, cashPnl: 10, realizedPnl: 2 }),
      position({ currentValue: 30, initialValue: 50, cashPnl: -20, realizedPnl: 3 }),
    ]);

    expect(summary.positionCount).toBe(2);
    expect(summary.positionsValue).toBe(90);
    expect(summary.costBasis).toBe(100);
    expect(summary.unrealizedPnl).toBe(-10);
    expect(summary.realizedPnl).toBe(5);
    expect(summary.unrealizedPnlPercent).toBe(-10);
  });

  it("returns null percent rather than Infinity when there is no cost basis", () => {
    const summary = summarizePositions([position({ currentValue: 5, cashPnl: 5 })]);
    expect(summary.unrealizedPnlPercent).toBeNull();
  });

  it("returns a zeroed summary for no positions", () => {
    expect(summarizePositions([])).toEqual({
      positionCount: 0,
      positionsValue: 0,
      costBasis: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      unrealizedPnlPercent: null,
    });
  });
});

describe("listPortfolioPositions", () => {
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

  it("asks /v2/positions for the deposit wallet, without offset", async () => {
    const fetchMock = mockFetch({ data: [v2Row], pagination: { has_more: false, next_cursor: null } });

    const positions = await listPortfolioPositions(client);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v2/positions");
    expect(url.searchParams.get("user")).toBe(WALLET);
    expect(url.searchParams.has("offset")).toBe(false);
    expect(positions).toHaveLength(1);
  });

  // an outage must read as an error, never as "you hold nothing"
  it("throws on the v1 retirement 410 rather than returning no positions", async () => {
    mockFetch({ error: "Data API v1 has been retired" }, 410);
    await expect(listPortfolioPositions(client)).rejects.toThrow("410");
  });

  it("throws on a body with no data envelope", async () => {
    mockFetch([v2Row]);
    await expect(listPortfolioPositions(client)).rejects.toThrow();
  });

  it("reads data: null as no positions, which v2 documents as a real miss", async () => {
    mockFetch({ data: null });
    await expect(listPortfolioPositions(client)).resolves.toEqual([]);
  });
});
