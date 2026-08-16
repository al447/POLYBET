import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPriceHistory, priceRange, toSparklinePath } from "./price-history";
import type { PricePoint } from "./price-history";

/** Trimmed from a real response — verified live 2026-08-16, interval=1w&fidelity=60. */
const fixture: PricePoint[] = [
  { t: 1786258812, p: 0.1815 },
  { t: 1786262411, p: 0.19 },
  { t: 1786266023, p: 0.17 },
  { t: 1786269613, p: 0.1645 },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("priceRange", () => {
  it("reports the extremes plus the ends of the window", () => {
    expect(priceRange(fixture)).toEqual({ min: 0.1645, max: 0.19, first: 0.1815, last: 0.1645 });
  });

  it("returns zeros on an empty series rather than NaN", () => {
    expect(priceRange([])).toEqual({ min: 0, max: 0, first: 0, last: 0 });
  });
});

describe("toSparklinePath", () => {
  it("scales to the series' own range, not a fixed 0-1", () => {
    // Two points spanning 0.2→0.4: the low pins to the bottom of the box and
    // the high to the top, regardless of how narrow the real range was.
    const path = toSparklinePath(
      [
        { t: 1, p: 0.2 },
        { t: 2, p: 0.4 },
      ],
      100,
      50,
    );
    expect(path).toBe("M0,50 L100,0");
  });

  it("centres a flat series instead of dividing by zero", () => {
    const path = toSparklinePath(
      [
        { t: 1, p: 0.5 },
        { t: 2, p: 0.5 },
      ],
      100,
      50,
    );
    expect(path).toBe("M0,25 L100,25");
  });

  it("keeps the stroke off the edges when inset", () => {
    const path = toSparklinePath(
      [
        { t: 1, p: 0 },
        { t: 2, p: 1 },
      ],
      100,
      50,
      { inset: 2 },
    );
    expect(path).toBe("M0,48 L100,2");
  });

  it("plots against an explicit domain so several series share one axis", () => {
    // Without a domain both of these would normalise to the full box and draw
    // as the same line, implying two markets are trading alike when one is at
    // 70-80% and the other at 20-30%.
    const domain = { min: 0, max: 1 };
    const high = toSparklinePath(
      [
        { t: 1, p: 0.7 },
        { t: 2, p: 0.8 },
      ],
      100,
      100,
      { domain },
    );
    const low = toSparklinePath(
      [
        { t: 1, p: 0.2 },
        { t: 2, p: 0.3 },
      ],
      100,
      100,
      { domain },
    );

    expect(high).toBe("M0,30 L100,20");
    expect(low).toBe("M0,80 L100,70");
  });

  it("centres a series when the domain has no width", () => {
    const path = toSparklinePath([{ t: 1, p: 0.5 }], 100, 50, { domain: { min: 0.5, max: 0.5 } });
    expect(path).toBe("M50,25");
  });

  it("centres a single point and returns nothing for an empty series", () => {
    expect(toSparklinePath([{ t: 1, p: 0.5 }], 100, 50)).toBe("M50,25");
    expect(toSparklinePath([], 100, 50)).toBe("");
  });

  it("emits one command per point, in order", () => {
    const path = toSparklinePath(fixture, 300, 100);
    expect(path.startsWith("M0,")).toBe(true);
    expect(path.split(" ")).toHaveLength(fixture.length);
  });
});

describe("fetchPriceHistory", () => {
  it("reads the `history` array off the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ history: fixture }), { status: 200 })),
    );

    await expect(fetchPriceHistory({ tokenId: "123" })).resolves.toEqual(fixture);
  });

  it("sends the token id as `market`, plus interval and fidelity", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ history: [] }), { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await fetchPriceHistory({ tokenId: "987", interval: "1d", fidelity: 15 });

    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/prices-history");
    expect(url.searchParams.get("market")).toBe("987");
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(url.searchParams.get("fidelity")).toBe("15");
  });

  it("drops malformed points rather than rendering NaN coordinates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ history: [{ t: 1, p: 0.5 }, { t: "x", p: 0.5 }, null, { p: 0.5 }] }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchPriceHistory({ tokenId: "123" })).resolves.toEqual([{ t: 1, p: 0.5 }]);
  });

  it("returns an empty series instead of throwing when the CLOB fails", async () => {
    // The hero must survive this — the chart is decorative, the page isn't.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(fetchPriceHistory({ tokenId: "123" })).resolves.toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchPriceHistory({ tokenId: "123" })).resolves.toEqual([]);
  });
});
