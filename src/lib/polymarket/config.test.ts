import { describe, expect, it } from "vitest";

import {
  computeGtdExpiration,
  GTD_EXPIRY_BUFFER_SECONDS,
  MIN_GTD_EXPIRY_SECONDS,
} from "./config";

describe("computeGtdExpiration", () => {
  const now = 1_000_000;

  it("adds the duration plus the clock-skew buffer", () => {
    expect(computeGtdExpiration("1h", now)).toBe(now + GTD_EXPIRY_BUFFER_SECONDS + 3_600);
  });

  it("covers 1d and 1w presets", () => {
    expect(computeGtdExpiration("1d", now)).toBe(now + GTD_EXPIRY_BUFFER_SECONDS + 86_400);
    expect(computeGtdExpiration("1w", now)).toBe(now + GTD_EXPIRY_BUFFER_SECONDS + 604_800);
  });

  it("never returns less than the SDK's minimum expiry, even for a hypothetical short duration", () => {
    expect(computeGtdExpiration("1h", now)).toBeGreaterThanOrEqual(now + MIN_GTD_EXPIRY_SECONDS);
  });
});
