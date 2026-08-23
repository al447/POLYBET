import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GammaEvent, KeysetPage } from "./gamma-types";

/**
 * `listEvents` is mocked rather than exercised: what is under test here is the
 * pagination loop in `fetchFixtures`, not Gamma's wire format. `gamma.test.ts`
 * already covers the fetch itself.
 */
const listEvents = vi.fn<(params?: unknown) => Promise<KeysetPage<GammaEvent>>>();

vi.mock("./gamma", () => ({
  listEvents: (params?: unknown) => listEvents(params),
}));

const { fetchFixtures } = await import("./fixtures");

/**
 * One page that always says "there is another page after me", so the loop only
 * ever stops because something stopped it — never because the data ran out.
 * The event is deliberately not a match event: `parseFixture` skips it, which
 * keeps the test about the loop rather than about fixture parsing.
 */
const endlessPage = (): KeysetPage<GammaEvent> => ({
  items: [{ id: "1", slug: "not-a-match", title: "Not a match" } as GammaEvent],
  nextCursor: "next-page",
});

/** `MAX_PAGES` in fixtures.ts. Kept here so a change to it fails loudly. */
const MAX_PAGES = 12;

beforeEach(() => {
  listEvents.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchFixtures pagination budget", () => {
  /**
   * 🚩 Pins the 2026-08-23 fix. `MAX_PAGES` (12) x `TOTAL_BUDGET_MS` (6s) is
   * 72 seconds of Gamma time in one request, against Cloudflare's 100s
   * timeout — and a request that runs that long holds a Worker isolate,
   * queueing every request behind it. `/predict-ai` was the second-worst 504
   * path on the site because of exactly this.
   *
   * The bound is on the whole loop, so this asserts it stops early on a slow
   * upstream instead of walking all twelve pages.
   */
  it("stops paginating once the loop budget is spent", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let elapsed = 0;

    listEvents.mockImplementation(async () => {
      // Each page costs a full gammaFetch budget — the worst realistic case.
      elapsed += 6_000;
      vi.setSystemTime(start + elapsed);
      return endlessPage();
    });

    const fixtures = await fetchFixtures();

    // 10s budget, checked between pages: page 1 at t=0, page 2 at t=6s, then
    // t=12s is past the deadline and the loop breaks.
    expect(listEvents).toHaveBeenCalledTimes(2);
    expect(listEvents.mock.calls.length).toBeLessThan(MAX_PAGES);
    // Partial, not thrown — a truncated board beats a 504.
    expect(fixtures).toEqual([]);
  });

  /**
   * The budget must not cost us pages on a healthy upstream — the 7-day window
   * genuinely needs the full walk (176 matches across ~1200 events, because the
   * derived markets are ~85% of the payload).
   */
  it("still walks every page when Gamma is fast", async () => {
    listEvents.mockImplementation(async () => endlessPage());

    await fetchFixtures();

    expect(listEvents).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it("stops early when the cursor runs out, without spending the budget", async () => {
    listEvents.mockImplementation(async () => ({
      items: [{ id: "1", slug: "s", title: "t" } as GammaEvent],
      nextCursor: null,
    }));

    await fetchFixtures();

    expect(listEvents).toHaveBeenCalledTimes(1);
  });
});
