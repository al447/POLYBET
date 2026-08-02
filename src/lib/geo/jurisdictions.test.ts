import { describe, expect, it } from "vitest";

import {
  canClosePositions,
  canOpenPositions,
  resolveGeoTier,
} from "./jurisdictions";

describe("resolveGeoTier", () => {
  it("blocks OFAC-sanctioned countries outright", () => {
    for (const country of ["IR", "SY", "CU", "KP"]) {
      expect(resolveGeoTier({ countryCode: country })).toBe("blocked");
    }
  });

  it("blocks occupied Ukrainian regions while leaving the rest of Ukraine open", () => {
    expect(resolveGeoTier({ countryCode: "UA", regionCode: "43" })).toBe("blocked");
    expect(resolveGeoTier({ countryCode: "UA", regionCode: "UA-14" })).toBe("blocked");
    expect(resolveGeoTier({ countryCode: "UA", regionCode: "32" })).toBe("allowed");
  });

  it("marks the major close-only jurisdictions", () => {
    for (const country of ["US", "GB", "FR", "DE", "SG", "AU", "BR"]) {
      expect(resolveGeoTier({ countryCode: country })).toBe("close-only");
    }
  });

  it("applies Canadian restrictions per province, not nationally", () => {
    expect(resolveGeoTier({ countryCode: "CA", regionCode: "ON" })).toBe("close-only");
    expect(resolveGeoTier({ countryCode: "CA", regionCode: "BC" })).toBe("close-only");
    expect(resolveGeoTier({ countryCode: "CA", regionCode: "NS" })).toBe("allowed");
  });

  it("treats frontend-only restrictions as their own tier", () => {
    expect(resolveGeoTier({ countryCode: "IE" })).toBe("frontend-restricted");
    expect(resolveGeoTier({ countryCode: "JP" })).toBe("frontend-restricted");
    expect(resolveGeoTier({ countryCode: "MT" })).toBe("frontend-restricted");
  });

  it("allows unrestricted countries", () => {
    expect(resolveGeoTier({ countryCode: "MX" })).toBe("allowed");
    expect(resolveGeoTier({ countryCode: "NG" })).toBe("allowed");
  });

  it("is case-insensitive", () => {
    expect(resolveGeoTier({ countryCode: "us" })).toBe("close-only");
    expect(resolveGeoTier({ countryCode: "ir" })).toBe("blocked");
  });

  describe("failing closed", () => {
    it("treats an unknown origin as close-only, never allowed", () => {
      expect(resolveGeoTier({ countryCode: null })).toBe("close-only");
      expect(resolveGeoTier({})).toBe("close-only");
      expect(resolveGeoTier({ countryCode: "" })).toBe("close-only");
    });

    it("honours an upstream block even for an otherwise-allowed country", () => {
      expect(
        resolveGeoTier({ countryCode: "MX", blockedByUpstream: true }),
      ).toBe("close-only");
    });

    it("keeps an OFAC block as fully blocked rather than downgrading it", () => {
      expect(
        resolveGeoTier({ countryCode: "IR", blockedByUpstream: true }),
      ).toBe("blocked");
    });
  });
});

describe("tier capabilities", () => {
  it("lets only allowed and frontend-restricted users open positions", () => {
    expect(canOpenPositions("allowed")).toBe(true);
    expect(canOpenPositions("frontend-restricted")).toBe(true);
    expect(canOpenPositions("close-only")).toBe(false);
    expect(canOpenPositions("blocked")).toBe(false);
  });

  it("lets everyone except blocked users exit positions", () => {
    expect(canClosePositions("allowed")).toBe(true);
    expect(canClosePositions("close-only")).toBe(true);
    expect(canClosePositions("frontend-restricted")).toBe(true);
    expect(canClosePositions("blocked")).toBe(false);
  });
});
