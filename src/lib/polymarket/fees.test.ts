import { describe, expect, it } from "vitest";

import {
  calculateFee,
  calculateFeeBreakdown,
  checkBalance,
  fromBaseUnits,
  resolveFeeBps,
  toBaseUnits,
} from "./fees";

describe("base unit conversion", () => {
  it("round-trips whole and fractional amounts", () => {
    expect(toBaseUnits("10")).toBe(10_000_000n);
    expect(toBaseUnits("10.5")).toBe(10_500_000n);
    expect(toBaseUnits("0.000001")).toBe(1n);
    expect(fromBaseUnits(10_500_000n)).toBe("10.5");
    expect(fromBaseUnits(1n)).toBe("0.000001");
    expect(fromBaseUnits(10_000_000n)).toBe("10");
  });

  it("truncates beyond 6 decimals rather than rounding into a larger charge", () => {
    expect(toBaseUnits("1.9999999")).toBe(1_999_999n);
  });

  it("rejects malformed input instead of coercing to zero", () => {
    expect(() => toBaseUnits("abc")).toThrow();
    expect(() => toBaseUnits("")).toThrow();
    expect(() => toBaseUnits("1.2.3")).toThrow();
  });
});

describe("calculateFee", () => {
  it("matches the documented example: 1000 pUSD at 100 bps = 10 pUSD", () => {
    expect(calculateFee(toBaseUnits("1000"), 100)).toBe(toBaseUnits("10"));
  });

  it("handles 1 bps granularity", () => {
    expect(calculateFee(toBaseUnits("1000"), 1)).toBe(toBaseUnits("0.1"));
  });

  it("rounds up so the order is never a sub-cent short of its own fee", () => {
    // 0.000001 * 1bps = 0.0000000001 -> rounds up to 1 base unit
    expect(calculateFee(1n, 1)).toBe(1n);
    // 333333 base units at 3 bps = 99.9999 -> 100
    expect(calculateFee(333_333n, 3)).toBe(100n);
  });

  it("returns zero for a zero or negative notional", () => {
    expect(calculateFee(0n, 100)).toBe(0n);
    expect(calculateFee(-5n, 100)).toBe(0n);
  });

  it("rejects rates above the Polymarket cap", () => {
    expect(() => calculateFee(toBaseUnits("10"), 101)).toThrow(/cap/);
  });
});

describe("calculateFeeBreakdown", () => {
  it("stacks the builder fee on top of the platform fee, never replacing it", () => {
    const breakdown = calculateFeeBreakdown({
      notional: toBaseUnits("100"),
      builderFeeBps: 100,
      platformFee: toBaseUnits("0.5"),
    });
    expect(breakdown.builderFee).toBe(toBaseUnits("1"));
    expect(breakdown.platformFee).toBe(toBaseUnits("0.5"));
    expect(breakdown.totalRequired).toBe(toBaseUnits("101.5"));
  });
});

describe("checkBalance", () => {
  it("passes when the balance covers notional plus all fees", () => {
    const result = checkBalance({
      balance: toBaseUnits("101.5"),
      notional: toBaseUnits("100"),
      builderFeeBps: 100,
      platformFee: toBaseUnits("0.5"),
    });
    expect(result.ok).toBe(true);
  });

  it("fails a balance that covers notional but not the fees (correction C-5)", () => {
    const result = checkBalance({
      balance: toBaseUnits("100"),
      notional: toBaseUnits("100"),
      builderFeeBps: 100,
      platformFee: toBaseUnits("0.5"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.shortfall).toBe(toBaseUnits("1.5"));
      expect(result.reason).toContain("short by 1.5");
    }
  });

  it("fails by exactly one base unit at the boundary", () => {
    const result = checkBalance({
      balance: toBaseUnits("101.499999"),
      notional: toBaseUnits("100"),
      builderFeeBps: 100,
      platformFee: toBaseUnits("0.5"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.shortfall).toBe(1n);
  });
});

describe("resolveFeeBps", () => {
  it("defaults to zero when unset", () => {
    expect(resolveFeeBps({})).toEqual({ taker: 0, maker: 0 });
  });

  it("rejects a taker rate over 100 bps", () => {
    expect(() => resolveFeeBps({ BUILDER_FEE_BPS_TAKER: "101" })).toThrow(/cap/);
  });

  it("rejects a maker rate over 50 bps", () => {
    expect(() => resolveFeeBps({ BUILDER_FEE_BPS_MAKER: "51" })).toThrow(/cap/);
  });
});
