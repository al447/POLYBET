import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GammaApiError,
  getMarketBySlug,
  listEvents,
  listMarkets,
  listTags,
  parseGammaJsonArray,
  projectEventForList,
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
  it("retries a 5xx with backoff, then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("", { status: 503 });
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );

    const promise = listEvents();
    await vi.runAllTimersAsync();
    const page = await promise;

    expect(calls).toBe(2);
    expect(page.items).toEqual([]);
  });

  /**
   * 🚩 Pins the 2026-08-22 change. A 429 used to be retryable, which meant
   * Gamma asking for fewer requests was answered with four times as many —
   * the feedback loop that turns load into an outage. Retrying it is strictly
   * worse than failing, so this asserts exactly one call.
   */
  it("does NOT retry a 429 — retrying a rate limit amplifies it", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("", { status: 429 });
      }),
    );

    const error = await listEvents().catch((e: unknown) => e);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(GammaApiError);
    expect((error as GammaApiError).status).toBe(429);
  });

  /**
   * The budget bounds the WHOLE call, so the attempt count is capped no matter
   * what upstream does. Before this change it was 4 attempts at 8s each with no
   * total ceiling (~34.5s); the homepage fans several of these out in parallel.
   */
  it("makes at most two attempts, and every attempt carries an abort signal", async () => {
    // Real timers on purpose. `AbortSignal.timeout` schedules outside the
    // timer queue vitest fakes, so mixing the two here is a flake risk; the
    // stub resolves instantly and the single backoff is ~300-450ms.
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        return new Response("", { status: 500 });
      }),
    );

    await listEvents().catch((error: unknown) => error);

    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
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

/**
 * 🚩 The browse-cache projection. Measured 2026-08-23: one live `/api/markets`
 * response was **6.80 MB** for 50 events / 1,619 nested markets, and that
 * payload — not the upstream fetch — is what pinned the homepage at its 8s
 * hero ceiling (Gamma answered in 0.07-0.55s; our cached layer took 1.46-3.56s
 * for the same data).
 *
 * These assert both halves of the contract: everything a card renders survives,
 * and the weight does not. A regression here is invisible at runtime — a
 * dropped field is missing content, never an error.
 */
describe("projectEventForList", () => {
  /** Shaped like a real Gamma market: declared fields plus undeclared noise. */
  const rawMarket = {
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
    active: true,
    closed: false,
    endDate: "2026-12-31T00:00:00Z",
    groupItemTitle: "X",
    description: "Long resolution prose that only the detail page ever shows.",
    resolutionSource: "https://example.com",
    // Undeclared in GammaMarket — 59 such keys ship on every real market.
    clobRewards: [{ id: "1", rewardsAmount: 5 }],
    positionIds: ["0xdead", "0xbeef"],
    questionID: "0xq",
    negRiskMarketID: "0xn",
  };

  const rawEvent = {
    id: "9001",
    slug: "some-event",
    title: "Some Event",
    description: "Event-level description — kept, the card can show it.",
    active: true,
    closed: false,
    volume: 1000,
    endDate: "2026-12-31T00:00:00Z",
    icon: "https://example.com/i.png",
    markets: [rawMarket],
    // Undeclared at event level too.
    seriesSlug: "noise",
    commentCount: 42,
  } as unknown as Parameters<typeof projectEventForList>[0];

  it("keeps every field a market card renders", () => {
    const [market] = projectEventForList(rawEvent).markets;

    // rankEventOutcomes' inputs — without these the outcome list is wrong.
    expect(market.outcomes).toBe('["Yes","No"]');
    expect(market.outcomePrices).toBe('["0.62","0.38"]');
    expect(market.clobTokenIds).toBe('["111","222"]');
    expect(market.groupItemTitle).toBe("X");
    expect(market.closed).toBe(false);
    expect(market.question).toBe("Will X happen?");
    // MarketCard's own reads.
    expect(market.id).toBe("253591");
    expect(market.conditionId).toBe("0xabc123");
  });

  it("drops the undeclared keys Gamma sends but nothing can read", () => {
    const projected = projectEventForList(rawEvent);
    const [market] = projected.markets;

    expect(market).not.toHaveProperty("clobRewards");
    expect(market).not.toHaveProperty("positionIds");
    expect(market).not.toHaveProperty("questionID");
    expect(market).not.toHaveProperty("negRiskMarketID");
    expect(projected).not.toHaveProperty("seriesSlug");
    expect(projected).not.toHaveProperty("commentCount");
  });

  /**
   * The single heaviest field in the payload, ~1.6 KB x 1,619 markets. Read
   * only by MarketRules/MarketFaq on /market/[slug], which is served by
   * getCachedEventBySlug — a different cache, deliberately not projected.
   */
  it("drops prose from NESTED markets but keeps it on the event", () => {
    const projected = projectEventForList(rawEvent);

    expect(projected.markets[0]).not.toHaveProperty("description");
    expect(projected.markets[0]).not.toHaveProperty("resolutionSource");
    expect(projected.description).toBe("Event-level description — kept, the card can show it.");
  });

  it("survives an event with no markets array", () => {
    const bare = { id: "1", slug: "s", title: "t", active: true, closed: false } as Parameters<
      typeof projectEventForList
    >[0];

    expect(projectEventForList(bare).markets).toEqual([]);
  });

  it("measurably shrinks the payload", () => {
    const before = JSON.stringify(rawEvent).length;
    const after = JSON.stringify(projectEventForList(rawEvent)).length;

    expect(after).toBeLessThan(before);
  });
});
