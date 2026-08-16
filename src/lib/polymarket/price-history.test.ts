import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRICE_RANGES,
  fetchPriceHistory,
  isPriceRangeId,
  priceRange,
  resolvePriceRange,
  toSparklinePath,
} from "./price-history";
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
    // Captured rather than read back off `spy.mock.calls`: the mock declares no
    // parameters, so its calls tuple types as `[]` and indexing it doesn't
    // compile.
    let requested = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        requested = input;
        return new Response(JSON.stringify({ history: [] }), { status: 200 });
      }),
    );

    await fetchPriceHistory({ tokenId: "987", interval: "1d", fidelity: 15 });

    const url = new URL(requested);
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

/**
 * Range presets.
 *
 * The reason these are a closed set rather than a free interval/fidelity pair
 * is measured, not stylistic: the CLOB returns an EMPTY history with a 200
 * when the two don't suit each other (`1w` + `fidelity=1` → 0 points,
 * `1m` + `fidelity=5` → 0 points, verified 2026-08-16). A caller that could
 * combine them freely could silently blank the chart.
 */
describe("PRICE_RANGES", () => {
  it("pairs every interval with a fidelity that returns data", () => {
    // Locks in the measured pairings. If one of these is ever changed, it must
    // be re-probed against the live API first — see the table on PRICE_RANGES.
    expect(PRICE_RANGES.map((range) => [range.interval, range.fidelity])).toEqual([
      ["1h", 1],
      ["6h", 5],
      ["1d", 5],
      ["1w", 60],
      ["1m", 60],
      ["max", 60],
    ]);
  });

  it("resolves known ids and falls back to the default on anything else", () => {
    expect(resolvePriceRange("1h").interval).toBe("1h");
    expect(resolvePriceRange("max").fidelity).toBe(60);
    expect(resolvePriceRange(null).id).toBe("1w");
    expect(resolvePriceRange("nonsense").id).toBe("1w");
  });

  it("narrows wire values for the API route", () => {
    expect(isPriceRangeId("6h")).toBe(true);
    expect(isPriceRangeId("6H")).toBe(false);
    expect(isPriceRangeId("2w")).toBe(false);
  });
});

describe("toSparklinePath with a shared time axis", () => {
  it("positions points by timestamp, not by index", () => {
    // A series that only covers the back half of the window must be drawn in
    // the back half — not stretched across the full width. Without this, a
    // market added late slides its whole history leftward against the others.
    const late = toSparklinePath(
      [
        { t: 150, p: 0.5 },
        { t: 200, p: 0.5 },
      ],
      100,
      50,
      { domain: { min: 0, max: 1 }, timeDomain: { start: 100, end: 200 } },
    );

    expect(late).toBe("M50,25 L100,25");
  });

  it("keeps two series with different point counts aligned in time", () => {
    const options = { domain: { min: 0, max: 1 }, timeDomain: { start: 0, end: 100 } };
    const dense = toSparklinePath(
      [
        { t: 0, p: 0.5 },
        { t: 50, p: 0.5 },
        { t: 100, p: 0.5 },
      ],
      100,
      50,
      options,
    );
    const sparse = toSparklinePath(
      [
        { t: 0, p: 0.5 },
        { t: 100, p: 0.5 },
      ],
      100,
      50,
      options,
    );

    // Both start at x=0 and end at x=100 despite having 3 and 2 points.
    expect(dense.startsWith("M0,")).toBe(true);
    expect(dense.endsWith("L100,25")).toBe(true);
    expect(sparse).toBe("M0,25 L100,25");
  });

  it("falls back to even index spacing when no time domain is given", () => {
    const path = toSparklinePath(
      [
        { t: 1000, p: 0.5 },
        { t: 9999, p: 0.5 },
      ],
      100,
      50,
      { domain: { min: 0, max: 1 } },
    );
    expect(path).toBe("M0,25 L100,25");
  });
});
