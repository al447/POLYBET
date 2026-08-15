import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CachedEventsResult } from "@/lib/polymarket/gamma";

/**
 * `/api/markets` param handling (FR-2.2).
 *
 * `getCachedEvents` is mocked rather than exercised: it is a `"use cache"`
 * function and needs Next's runtime, which isn't what's under test here. What
 * matters is the params this route hands it — particularly `order`/`ascending`,
 * which Gamma 422s on if they don't match the sort a cursor was generated
 * under.
 */
const getCachedEvents = vi.fn<(params?: unknown) => Promise<CachedEventsResult>>();

vi.mock("@/lib/polymarket/gamma", () => ({
  getCachedEvents: (params?: unknown) => getCachedEvents(params),
}));

const { GET } = await import("./route");

const emptyPage: CachedEventsResult = {
  ok: true,
  generatedAt: "2026-08-15T00:00:00.000Z",
  items: [],
  nextCursor: null,
};

const call = (query = "") => GET(new Request(`https://example.test/api/markets${query}`));

/** The params the route passed to `getCachedEvents` on its most recent call. */
const lastParams = () => getCachedEvents.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => {
  getCachedEvents.mockReset();
  getCachedEvents.mockResolvedValue(emptyPage);
});

describe("sort handling", () => {
  it("defaults to highest-volume-first when no sort is given", async () => {
    await call();

    expect(lastParams()).toMatchObject({ order: "volume", ascending: false });
  });

  it("maps a sort id to its order/ascending pair", async () => {
    await call("?sort=ending");

    expect(lastParams()).toMatchObject({ order: "endDate", ascending: true });
  });

  it("rejects an unknown sort id rather than silently serving the default", async () => {
    const response = await call("?sort=cheapest");

    expect(response.status).toBe(400);
    expect(getCachedEvents).not.toHaveBeenCalled();
  });

  it("rejects a raw Gamma order value — sorts travel as ids only", async () => {
    const response = await call("?sort=volume");

    expect(response.status).toBe(400);
  });

  // The regression this whole change exists to fix: page 1 sorted by volume,
  // page 2 dropped `order`, and Gamma 422'd the cursor because it was bound to
  // the volume sort. Both fields must survive pagination unchanged.
  it("keeps order and ascending when a cursor is present", async () => {
    await call("?sort=liquidity&cursor=abc");

    expect(lastParams()).toMatchObject({
      cursor: "abc",
      order: "liquidity",
      ascending: false,
    });
  });
});

describe("range filters", () => {
  it("sends no bounds when no filters are given", async () => {
    await call();

    expect(lastParams()).toMatchObject({
      volumeMin: undefined,
      liquidityMin: undefined,
      endDateMax: undefined,
    });
  });

  it("maps volume and liquidity ids to their numeric bounds", async () => {
    await call("?volume=1m&liquidity=50k");

    expect(lastParams()).toMatchObject({ volumeMin: 1_000_000, liquidityMin: 50_000 });
  });

  it("turns an ending preset into a day-quantised endDateMax", async () => {
    await call("?ending=7d");

    // Quantised to end-of-day UTC so the value is a stable cache key rather
    // than changing on every request. Asserted by shape, not a fixed instant.
    expect(String(lastParams().endDateMax)).toMatch(/T23:59:59\.999Z$/);
  });

  it("rejects an unknown filter id", async () => {
    expect((await call("?volume=squillions")).status).toBe(400);
    expect((await call("?liquidity=lots")).status).toBe(400);
    expect((await call("?ending=someday")).status).toBe(400);
    expect(getCachedEvents).not.toHaveBeenCalled();
  });

  it("keeps filters alongside a cursor and sort", async () => {
    await call("?sort=ending&volume=100k&cursor=abc");

    expect(lastParams()).toMatchObject({
      cursor: "abc",
      order: "endDate",
      ascending: true,
      volumeMin: 100_000,
    });
  });
});

describe("existing param handling", () => {
  it("excludes resolved markets by default", async () => {
    await call();

    expect(lastParams()).toMatchObject({ active: true, closed: false });
  });

  it("rejects a malformed limit", async () => {
    const response = await call("?limit=abc");

    expect(response.status).toBe(400);
  });

  it("surfaces an upstream failure as a 502", async () => {
    getCachedEvents.mockResolvedValue({ ok: false, error: "Gamma unreachable", status: 500 });

    const response = await call();

    expect(response.status).toBe(502);
  });

  it("surfaces an upstream 404 as a 404", async () => {
    getCachedEvents.mockResolvedValue({ ok: false, error: "not found", status: 404 });

    const response = await call();

    expect(response.status).toBe(404);
  });
});
