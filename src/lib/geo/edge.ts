import { POLYMARKET_ENDPOINTS } from "@/lib/polymarket/config";
import { resolveGeoTier, type GeoTier } from "./jurisdictions";

/**
 * Edge-safe geo resolution.
 *
 * Separate from `./index.ts` purely because the middleware gate runs on the
 * Edge runtime (see src/middleware.ts for why) and cannot import `server-only`.
 * Everything here uses fetch, Set and string operations, all Edge-compatible.
 */

export type GeoStatus = {
  tier: GeoTier;
  countryCode: string | null;
  regionCode: string | null;
  /** True when the upstream check failed and we fell back to headers. */
  degraded: boolean;
};

/**
 * Shape of `GET https://polymarket.com/api/geoblock`.
 *
 * The live response uses `country` and `region`:
 *   `{"blocked":false,"ip":"1.2.3.4","country":"BD","region":"C"}`
 *
 * The `*Code` aliases are tolerated because this endpoint is undocumented and
 * has no stability guarantee — reading only one spelling is how the country
 * silently became `undefined` and every caller fell through to the fail-closed
 * branch, which presents as "close-only" for users who are not restricted.
 */
type UpstreamGeoblock = {
  blocked?: boolean;
  country?: string;
  region?: string;
  countryCode?: string;
  regionCode?: string;
  ip?: string;
};

const upstreamCountry = (u: UpstreamGeoblock) => u.country ?? u.countryCode;
const upstreamRegion = (u: UpstreamGeoblock) => u.region ?? u.regionCode;

const UPSTREAM_TIMEOUT_MS = 2_500;

/**
 * Resolves the caller's geo tier.
 *
 * Asks Polymarket's own geoblock endpoint first — it is authoritative and
 * tracks their jurisdiction changes without us redeploying. Falls back to
 * Cloudflare's `cf-ipcountry` header, and fails closed (see `resolveGeoTier`)
 * when nothing is known.
 */
export async function resolveGeoStatus(request: Request): Promise<GeoStatus> {
  const headerCountry =
    request.headers.get("cf-ipcountry") ??
    request.headers.get("x-vercel-ip-country");
  const headerRegion =
    request.headers.get("cf-region-code") ??
    request.headers.get("x-vercel-ip-country-region");

  const upstream = await fetchUpstreamGeoblock(request);

  if (!upstream) {
    return {
      tier: resolveGeoTier({
        countryCode: headerCountry,
        regionCode: headerRegion,
      }),
      countryCode: headerCountry,
      regionCode: headerRegion,
      degraded: true,
    };
  }

  const countryCode = upstreamCountry(upstream) ?? headerCountry;
  const regionCode = upstreamRegion(upstream) ?? headerRegion;

  return {
    tier: resolveGeoTier({
      countryCode,
      regionCode,
      blockedByUpstream: upstream.blocked,
    }),
    countryCode: countryCode ?? null,
    regionCode: regionCode ?? null,
    // A response we could not extract a country from is not a healthy check,
    // even though the request itself succeeded — the tier below it is the
    // fail-closed default rather than a real determination.
    degraded: !countryCode,
  };
}

async function fetchUpstreamGeoblock(
  request: Request,
): Promise<UpstreamGeoblock | null> {
  const forwardedFor =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for");

  try {
    const response = await fetch(POLYMARKET_ENDPOINTS.geoblock, {
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as UpstreamGeoblock;
  } catch {
    // Network failure, timeout, or shape change. Caller degrades to headers.
    return null;
  }
}
