import { describe, expect, it } from "vitest";
import type { Position } from "@polymarket/bindings/data";

import { summarizePositions } from "./portfolio";

/**
 * Only the money fields `summarizePositions` reads are set — the rest of
 * `Position` is branded/optional and irrelevant here, so fixtures cast
 * through `unknown` rather than restating the whole schema (same approach as
 * `market-data.test.ts`).
 */
function position(fields: Partial<Record<"currentValue" | "initialValue" | "cashPnl" | "realizedPnl", string>>): Position {
  return fields as unknown as Position;
}

describe("summarizePositions", () => {
  it("sums value, cost, and both PnL figures across positions", () => {
    const summary = summarizePositions([
      position({ currentValue: "60", initialValue: "50", cashPnl: "10", realizedPnl: "2" }),
      position({ currentValue: "30", initialValue: "50", cashPnl: "-20", realizedPnl: "3" }),
    ]);

    expect(summary.positionCount).toBe(2);
    expect(summary.positionsValue).toBe(90);
    expect(summary.costBasis).toBe(100);
    expect(summary.unrealizedPnl).toBe(-10);
    expect(summary.realizedPnl).toBe(5);
    expect(summary.unrealizedPnlPercent).toBe(-10);
  });

  it("treats missing and null money fields as zero rather than producing NaN", () => {
    const summary = summarizePositions([
      position({ currentValue: "25" }),
      position({}),
    ]);

    expect(summary.positionsValue).toBe(25);
    expect(summary.costBasis).toBe(0);
    expect(summary.unrealizedPnl).toBe(0);
    expect(summary.realizedPnl).toBe(0);
    expect(Number.isNaN(summary.positionsValue)).toBe(false);
  });

  it("ignores unparseable values instead of poisoning the total", () => {
    const summary = summarizePositions([
      position({ currentValue: "10" }),
      position({ currentValue: "not-a-number" }),
    ]);

    expect(summary.positionsValue).toBe(10);
  });

  it("returns null percent rather than Infinity when there is no cost basis", () => {
    const summary = summarizePositions([position({ currentValue: "5", cashPnl: "5" })]);
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
