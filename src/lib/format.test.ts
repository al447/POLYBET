import { describe, expect, it } from "vitest";

import { formatEndDate, formatRelativeTime, formatUsd } from "./format";

describe("formatUsd", () => {
  it("abbreviates millions and thousands", () => {
    expect(formatUsd(1_258_713_663)).toBe("$1258.7M");
    expect(formatUsd(1_300_000)).toBe("$1.3M");
    expect(formatUsd(263_700)).toBe("$263.7K");
    expect(formatUsd(412)).toBe("$412");
  });

  it("accepts the JSON-string numbers Gamma returns", () => {
    expect(formatUsd("9400954.042289")).toBe("$9.4M");
  });

  it("falls back to $0 on missing or unparseable input", () => {
    expect(formatUsd(undefined)).toBe("$0");
    expect(formatUsd("not a number")).toBe("$0");
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("formatEndDate", () => {
  const now = new Date("2026-08-16T12:00:00Z");

  it("reports an undated event rather than rendering an empty slot", () => {
    // ~2 events per 100 have no endDate and some are real, high-volume
    // markets — see the `endingAfter` note in gamma-types.ts.
    expect(formatEndDate(undefined, now)).toBe("No end date");
    expect(formatEndDate("garbage", now)).toBe("No end date");
  });

  it("marks already-past dates as ended", () => {
    // Gamma leaves expired events flagged open, so this branch is reached by
    // real data, not just by defensive coding.
    expect(formatEndDate("2025-11-03T00:00:00Z", now)).toBe("Ended");
  });

  it("formats a future date", () => {
    expect(formatEndDate("2026-11-03T00:00:00Z", now)).toMatch(/Nov 3, 2026/);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-16T12:00:00Z");

  it("steps through the units", () => {
    expect(formatRelativeTime("2026-08-16T11:59:30Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-08-16T11:45:00Z", now)).toBe("15m ago");
    expect(formatRelativeTime("2026-08-15T16:00:00Z", now)).toBe("20h ago");
    expect(formatRelativeTime("2026-08-13T12:00:00Z", now)).toBe("3d ago");
    expect(formatRelativeTime("2026-06-16T12:00:00Z", now)).toBe("2mo ago");
    expect(formatRelativeTime("2024-08-16T12:00:00Z", now)).toBe("2y ago");
  });

  it("returns an empty string rather than 'Invalid Date' on bad input", () => {
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});
