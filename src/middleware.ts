import { NextResponse, type NextRequest } from "next/server";

import { resolveGeoStatus } from "@/lib/geo/edge";
import { canOpenPositions } from "@/lib/geo/jurisdictions";

/**
 * Geoblock gate (FR-6.1).
 *
 * ⚠️ This is `middleware.ts`, NOT Next 16's `proxy.ts`, and that is deliberate.
 *
 * Next 16 renamed middleware to `proxy` and made it Node-runtime-only. But
 * `@opennextjs/cloudflare` does not support Node middleware — the build fails
 * outright with "Node.js middleware is not currently supported"
 * (opennextjs-cloudflare#962). `middleware.ts` on the Edge runtime is
 * deprecated in Next 16 but is the only form that deploys to Workers today.
 *
 * Practical impact is small: this gate only does a fetch plus string/Set
 * comparisons, all of which the Edge runtime supports. Route handlers still run
 * on Node via OpenNext, so EIP-712 signing is unaffected.
 *
 * Revisit once OpenNext supports Node middleware — then this becomes proxy.ts.
 *
 * The gate is a UX affordance, not the enforcement boundary: Polymarket rejects
 * restricted orders server-side regardless, and /api/orders re-checks. Without
 * it users hit an opaque failure at the moment they try to spend money.
 */

const GEO_HEADER = "x-geo-tier";
const GEO_COUNTRY_HEADER = "x-geo-country";

/** Routes that open new positions. Close-only users must not reach these. */
const OPEN_POSITION_PATHS = ["/api/orders"];

export async function middleware(request: NextRequest) {
  const geo = await resolveGeoStatus(request);
  const { pathname } = request.nextUrl;

  // Fully blocked: no trading surface at all, including closing positions.
  if (geo.tier === "blocked") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "unavailable_in_region", tier: geo.tier },
        { status: 451 },
      );
    }
    if (!pathname.startsWith("/restricted")) {
      return NextResponse.redirect(new URL("/restricted", request.url));
    }
  }

  // Close-only: may exit positions, may not open them.
  if (
    !canOpenPositions(geo.tier) &&
    OPEN_POSITION_PATHS.some((p) => pathname.startsWith(p)) &&
    request.method === "POST"
  ) {
    return NextResponse.json(
      {
        error: "close_only_region",
        tier: geo.tier,
        message:
          "You can close existing positions, but cannot open new ones from your location.",
      },
      { status: 451 },
    );
  }

  // Pass the resolved tier downstream. /api/orders re-checks rather than
  // trusting this header as its only control.
  const response = NextResponse.next();
  response.headers.set(GEO_HEADER, geo.tier);
  if (geo.countryCode) response.headers.set(GEO_COUNTRY_HEADER, geo.countryCode);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
