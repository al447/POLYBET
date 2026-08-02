/**
 * Polymarket geographic restrictions.
 *
 * Source: https://docs.polymarket.com/api-reference/geoblock.md (verified 2026-08-02)
 *
 * These lists are a UX affordance, not the enforcement boundary — Polymarket
 * rejects orders from restricted regions server-side regardless of what we do.
 * We check client-side so users get a real explanation instead of an opaque
 * failure at submit time.
 *
 * Re-verify against the live endpoint each milestone; jurisdictions change.
 */

export type GeoTier =
  /** OFAC-sanctioned. No trading at all, cannot even close positions. */
  | "blocked"
  /** May close existing positions; may not open new ones. */
  | "close-only"
  /** Polymarket's own frontend restricts, but the API does not. */
  | "frontend-restricted"
  | "allowed";

/** ISO-3166-1 alpha-2, plus region codes where the restriction is sub-national. */
export const BLOCKED_COUNTRIES = new Set(["IR", "SY", "CU", "KP"]);

/** Occupied Ukrainian regions, blocked at region granularity. */
export const BLOCKED_REGIONS = new Set(["UA-43", "UA-14", "UA-09"]);

export const CLOSE_ONLY_COUNTRIES = new Set([
  "US", "GB", "FR", "DE", "SG", "AU", "BR", "RU", "TW",
  "BE", "PT", "PL", "IT", "ES", "CH", "AT", "SE", "NO", "DK", "FI",
  "CZ", "GR", "HU", "RO", "SK", "SI", "SE", "TH", "TR", "AE", "KR",
]);

/** Canadian provinces with their own prohibitions. */
export const CLOSE_ONLY_REGIONS = new Set(["CA-BC", "CA-ON", "CA-AB", "CA-QC"]);

/** Polymarket's frontend restricts these; the API itself does not. */
export const FRONTEND_RESTRICTED_COUNTRIES = new Set(["IE", "JP", "NL"]);

/** Malta is sports-markets-only rather than a blanket restriction. */
export const SPORTS_ONLY_COUNTRIES = new Set(["MT"]);

export type GeoInput = {
  countryCode?: string | null;
  regionCode?: string | null;
  /** Authoritative answer from Polymarket's own endpoint, when we have it. */
  blockedByUpstream?: boolean;
};

/**
 * Resolves a geo tier. Fails closed: an unknown or missing country is treated
 * as `close-only` rather than `allowed`, so a lookup failure can never open
 * trading to someone who should not have it.
 */
export function resolveGeoTier(input: GeoInput): GeoTier {
  const country = input.countryCode?.toUpperCase() ?? null;
  const region = normalizeRegion(country, input.regionCode);

  if (country && BLOCKED_COUNTRIES.has(country)) return "blocked";
  if (region && BLOCKED_REGIONS.has(region)) return "blocked";

  // Upstream is authoritative for anything short of an OFAC block.
  if (input.blockedByUpstream) return "close-only";

  if (region && CLOSE_ONLY_REGIONS.has(region)) return "close-only";
  if (country && CLOSE_ONLY_COUNTRIES.has(country)) return "close-only";

  if (country && FRONTEND_RESTRICTED_COUNTRIES.has(country)) {
    return "frontend-restricted";
  }
  if (country && SPORTS_ONLY_COUNTRIES.has(country)) {
    return "frontend-restricted";
  }

  // Fail closed on an unknown origin.
  if (!country) return "close-only";

  return "allowed";
}

function normalizeRegion(
  country: string | null,
  region: string | null | undefined,
): string | null {
  if (!region) return null;
  const upper = region.toUpperCase();
  if (upper.includes("-")) return upper;
  return country ? `${country}-${upper}` : upper;
}

/** Whether this tier may open new positions. */
export function canOpenPositions(tier: GeoTier): boolean {
  return tier === "allowed" || tier === "frontend-restricted";
}

/** Whether this tier may close/sell existing positions. */
export function canClosePositions(tier: GeoTier): boolean {
  return tier !== "blocked";
}

export function geoExplanation(tier: GeoTier): string {
  switch (tier) {
    case "blocked":
      return "Trading is not available in your location.";
    case "close-only":
      return "You can close existing positions, but cannot open new ones from your location.";
    case "frontend-restricted":
      return "Some markets are restricted in your location.";
    case "allowed":
      return "";
  }
}
