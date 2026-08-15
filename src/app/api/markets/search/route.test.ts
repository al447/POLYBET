import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CachedSearchResult } from "@/lib/polymarket/gamma";

/**
 * `/api/markets/search` param handling (FR-2.4).
 *
 * `getCachedSearch` is mocked — it's a `"use cache"` function needing Next's
 * runtime, and what's under test is the params this route builds.
 */
const getCachedSearch = vi.fn<(params?: unknown) => Promise<CachedSearchResult>>();

vi.mock("@/lib/polymarket/gamma", () => ({
  getCachedSearch: (params?: unknown) => getCachedSearch(params),
}));

const { GET } = await import("./route");

const emptyPage: CachedSearchResult = {
  ok: true,
  generatedAt: "2026-08-15T00:00:00.000Z",
  items: [],
  page: 1,
  hasMore: false,
  totalResults: 0,
};

const call = (query = "") => GET(new Request(`https://example.test/api/markets/search${query}`));

const lastParams = () => getCachedSearch.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => {
  getCachedSearch.mockReset();
  getCachedSearch.mockResolvedValue(emptyPage);
});

describe("query handling", () => {
  it("requires a query", async () => {
    expect((await call()).status).toBe(400);
    expect(getCachedSearch).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only query as missing", async () => {
    expect((await call("?q=%20%20")).status).toBe(400);
    expect(getCachedSearch).not.toHaveBeenCalled();
  });

  it("rejects an over-long query", async () => {
    const response = await call(`?q=${"a".repeat(129)}`);

    expect(response.status).toBe(400);
  });

  it("trims and lower-cases so trivial variants share a cache entry", async () => {
    await call("?q=%20%20Trump%20%20");

    expect(lastParams()).toMatchObject({ query: "trump" });
  });
});

describe("pagination", () => {
  it("defaults to page 1", async () => {
    await call("?q=trump");

    expect(lastParams()).toMatchObject({ page: 1 });
  });

  it("passes an explicit page through", async () => {
    await call("?q=trump&page=4");

    expect(lastParams()).toMatchObject({ page: 4 });
  });

  it("rejects a page outside the allowed range", async () => {
    // Capped because `page` lands in the cache key — an arbitrary page number
    // is a cheap way to fill it with misses.
    expect((await call("?q=trump&page=0")).status).toBe(400);
    expect((await call("?q=trump&page=101")).status).toBe(400);
    expect((await call("?q=trump&page=abc")).status).toBe(400);
  });

  it("never asks upstream for more than it can return", async () => {
    await call("?q=trump");

    expect(Number(lastParams().limit)).toBeLessThanOrEqual(50);
  });
});

describe("already-ended results", () => {
  const event = (id: string, endDate: string | undefined, closed = false) =>
    ({ id, endDate, closed }) as never;

  it("drops results whose end date has passed", async () => {
    // `/public-search` ignores `end_date_min`, and `events_status=active` only
    // excludes *closed* events — about 1 in 20 come back ended but open.
    getCachedSearch.mockResolvedValue({
      ...emptyPage,
      items: [event("live", "2099-01-01T00:00:00Z"), event("ended", "2020-01-01T00:00:00Z")],
      totalResults: 2,
    });

    const body = (await (await call("?q=trump")).json()) as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).toEqual(["live"]);
  });

  it("keeps undated events", async () => {
    getCachedSearch.mockResolvedValue({ ...emptyPage, items: [event("undated", undefined)] });

    const body = (await (await call("?q=trump")).json()) as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).toEqual(["undated"]);
  });

  it("reports Gamma's unfiltered total, which can read slightly high", async () => {
    getCachedSearch.mockResolvedValue({
      ...emptyPage,
      items: [event("ended", "2020-01-01T00:00:00Z")],
      totalResults: 3833,
    });

    const body = (await (await call("?q=trump")).json()) as Record<string, unknown>;

    expect(body.items).toEqual([]);
    expect(body.totalResults).toBe(3833);
  });
});

describe("upstream failures", () => {
  it("surfaces a failure as a 502", async () => {
    getCachedSearch.mockResolvedValue({ ok: false, error: "Gamma unreachable", status: 500 });

    expect((await call("?q=trump")).status).toBe(502);
  });

  it("returns the result envelope on success", async () => {
    getCachedSearch.mockResolvedValue({
      ok: true,
      generatedAt: "2026-08-15T00:00:00.000Z",
      items: [],
      page: 2,
      hasMore: true,
      totalResults: 3833,
    });

    const body = (await (await call("?q=trump&page=2")).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ page: 2, hasMore: true, totalResults: 3833 });
  });
});
