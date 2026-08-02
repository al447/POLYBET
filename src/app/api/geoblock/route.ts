import { NextResponse } from "next/server";

import { canClosePositions, canOpenPositions, geoExplanation } from "@/lib/geo/jurisdictions";
import { resolveGeoStatus } from "@/lib/geo";

/**
 * Geo status for the calling client (FR-6.1).
 *
 * Never cached: the answer is per-request and caching it across users would
 * hand one user another user's trading permissions.
 */
export async function GET(request: Request) {
  const geo = await resolveGeoStatus(request);

  return NextResponse.json(
    {
      tier: geo.tier,
      countryCode: geo.countryCode,
      regionCode: geo.regionCode,
      canOpenPositions: canOpenPositions(geo.tier),
      canClosePositions: canClosePositions(geo.tier),
      message: geoExplanation(geo.tier),
      degraded: geo.degraded,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
