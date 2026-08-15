import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GammaApiError,
  getMarketBySlug,
  listEvents,
  listMarkets,
  listTags,
  parseGammaJsonArray,
  searchEvents,
} from "./gamma";

/**
 * Fixtures trimmed from real Gamma responses (docs.polymarket.com,
 * verified 2026-08-07) — full objects have dozens more fields than we type,
 * these keep only what GammaMarket/GammaEvent declare.
 */
const fixtureMarket = {
  id: "253591",
  conditionId: "0xabc123",
  slug: "will-x-happen",
  question: "Will X happen?",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.62","0.38"]',
  clobTokenIds: '["111","222"]',
  volume: "125000.5",
  volumeNum: 125000.5,
  liquidity: "42000",
  liquidityNum: 42000,
  active: true,
  closed: false,
  endDate: "2026-12-31T00:00:00Z",
};

const fixtureEvent = {
  id: "9001",
  slug: "some-event",
  title: "Some Event",
  active: true,
  closed: false,
  markets: [fixtureMarket],
};

const mockFetchOnce = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("listEvents", () => {
  it("maps events and the next cursor", async () => {
    mockFetchOnce({ events: [fixtureEvent], next_cursor: "cursor-2" });

    const page = await listEvents({ limit: 10 });

    expect(page.items).toEqual([fixtureEvent]);
    expect(page.nextCursor).toBe("cursor-2");
  });

  it("reports null cursor on the last page", async () => {
    mockFetchOnce({ events: [] });

    const page = await listEvents();

    expect(page.nextCursor).toBeNull();
  });

  it("sends after_cursor, not offset, on the keyset endpoint", async () => {
    let requestedUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requestedUrl = new URL(input);
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );

    await listEvents({ cursor: "abc", active: true, tagId: 5 });

    expect(requestedUrl?.pathname).toBe("/events/keyset");
    expect(requestedUrl?.searchParams.get("after_cursor")).toBe("abc");
    expect(requestedUrl?.searchParams.get("active")).toBe("true");
    expect(requestedUrl?.searchParams.get("tag_id")).toBe("5");
    expect(requestedUrl?.searchParams.has("offset")).toBe(false);
  });

  // Regression guard. A keyset cursor is bound to the sort that produced it:
  // replaying it under a different order — including none — makes Gamma 422.
  // Re-probed live 2026-08-15, correcting a 2026-08-07 note that had it
  // backwards and dropped `order` once paginating, which broke "Load more".
  it("still sends order and ascending when paginating with a cursor", async () => {
    let requestedUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requestedUrl = new URL(input);
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );

    await listEvents({ cursor: "page-2", order: "volume", ascending: false });

    expect(requestedUrl?.searchParams.get("after_cursor")).toBe("page-2");
    expect(requestedUrl?.searchParams.get("order")).toBe("volume");
    expect(requestedUrl?.searchParams.get("ascending")).toBe("false");
  });

  it("maps range filters to Gamma's snake_case params", async () => {
    let requestedUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requestedUrl = new URL(input);
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );

    await listEvents({
      volumeMin: 100_000,
      liquidityMin: 50_000,
      endDateMax: "2026-08-22T23:59:59.999Z",
    });

    expect(requestedUrl?.searchParams.get("volume_min")).toBe("100000");
    expect(requestedUrl?.searchParams.get("liquidity_min")).toBe("50000");
    expect(requestedUrl?.searchParams.get("end_date_max")).toBe("2026-08-22T23:59:59.999Z");
  });

  it("omits range filters that aren't set", async () => {
    let requestedUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requestedUrl = new URL(input);
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );

    await listEvents({ volumeMin: 100_000 });

    expect(requestedUrl?.searchParams.has("volume_min")).toBe(true);
    expect(requestedUrl?.searchParams.has("liquidity_min")).toBe(false);
    expect(requestedUrl?.searchParams.has("end_date_max")).toBe(false);
    expect(requestedUrl?.searchParams.has("end_date_min")).toBe(false);
  });
});

describe("searchEvents", () => {
  const captureUrl = () => {
    const seen: { url?: URL } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        seen.url = new URL(input);
        return new Response(
          JSON.stringify({ events: [fixtureEvent], pagination: { hasMore: true, totalResults: 42 } }),
          { status: 200 },
        );
      }),
    );
    return seen;
  };

  it("hits /public-search and maps the pagination envelope", async () => {
    const seen = captureUrl();

    const page = await searchEvents({ query: "trump" });

    expect(seen.url?.pathname).toBe("/public-search");
    expect(seen.url?.searchParams.get("q")).toBe("trump");
    expect(page.items).toEqual([fixtureEvent]);
    expect(page.hasMore).toBe(true);
    expect(page.totalResults).toBe(42);
  });

  // 🚩 `closed=false` is silently ignored by this endpoint — `events_status`
  // is the only thing that excludes resolved markets. Verified live
  // 2026-08-15: without it, 3 of 10 results came back closed.
  it("always sends events_status=active", async () => {
    const seen = captureUrl();

    await searchEvents({ query: "trump" });

    expect(seen.url?.searchParams.get("events_status")).toBe("active");
  });

  it("paginates by page number, not cursor", async () => {
    const seen = captureUrl();

    const page = await searchEvents({ query: "trump", page: 3 });

    expect(seen.url?.searchParams.get("page")).toBe("3");
    expect(seen.url?.searchParams.has("after_cursor")).toBe(false);
    expect(page.page).toBe(3);
  });

  it("clamps limit to the upstream ceiling of 50", async () => {
    const seen = captureUrl();

    await searchEvents({ query: "trump", limit: 500 });

    expect(seen.url?.searchParams.get("limit_per_type")).toBe("50");
  });

  it("floors the page at 1", async () => {
    const seen = captureUrl();

    await searchEvents({ query: "trump", page: 0 });

    expect(seen.url?.searchParams.get("page")).toBe("1");
  });

  it("tolerates a response with no events or pagination", async () => {
    mockFetchOnce({});

    const page = await searchEvents({ query: "nothing-matches-this" });

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.totalResults).toBe(0);
  });
});

describe("listMarkets", () => {
  it("maps markets and the next cursor", async () => {
    mockFetchOnce({ markets: [fixtureMarket], next_cursor: null });

    const page = await listMarkets();

    expect(page.items).toEqual([fixtureMarket]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("getMarketBySlug", () => {
  it("fetches the market by slug", async () => {
    mockFetchOnce(fixtureMarket);

    const market = await getMarketBySlug("will-x-happen");

    expect(market?.slug).toBe("will-x-happen");
  });

  it("returns null on 404 instead of throwing", async () => {
    mockFetchOnce({}, 404);

    expect(await getMarketBySlug("does-not-exist")).toBeNull();
  });
});

describe("listTags", () => {
  it("returns the tag list for building category filters", async () => {
    mockFetchOnce([{ id: "1", label: "Politics", slug: "politics" }]);

    const tags = await listTags();

    expect(tags).toEqual([{ id: "1", label: "Politics", slug: "politics" }]);
  });
});

describe("retry behavior", () => {
  it("retries on 429/5xx with backoff, then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("", { status: 429 });
        if (calls === 2) return new Response("", { status: 503 });
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );

    const promise = listEvents();
    await vi.runAllTimersAsync();
    const page = await promise;

    expect(calls).toBe(3);
    expect(page.items).toEqual([]);
  });

  it("does not retry a 404", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("", { status: 404 });
      }),
    );

    await expect(getMarketBySlug("nope")).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries and throws GammaApiError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );

    const promise = listEvents().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(error).toBeInstanceOf(GammaApiError);
    expect((error as GammaApiError).status).toBe(500);
  });
});

describe("parseGammaJsonArray", () => {
  it("parses Gamma's JSON-encoded-string fields", () => {
    expect(parseGammaJsonArray<string>(fixtureMarket.outcomes)).toEqual(["Yes", "No"]);
    expect(parseGammaJsonArray<string>(fixtureMarket.outcomePrices)).toEqual(["0.62", "0.38"]);
  });

  it("falls back safely on missing or malformed input", () => {
    expect(parseGammaJsonArray(undefined)).toEqual([]);
    expect(parseGammaJsonArray(null)).toEqual([]);
    expect(parseGammaJsonArray("not json")).toEqual([]);
    expect(parseGammaJsonArray('{"not":"an array"}')).toEqual([]);
  });
});
