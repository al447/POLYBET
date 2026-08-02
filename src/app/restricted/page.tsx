import { Suspense } from "react";
import { headers } from "next/headers";

import { geoExplanation, type GeoTier } from "@/lib/geo/jurisdictions";

/**
 * Shown when the geo gate blocks a user (FR-6.2).
 *
 * The middleware redirects here rather than failing silently — a user who
 * cannot trade deserves to be told why before they try to deposit.
 *
 * Under Next 16 Cache Components, reading `headers()` is uncached data and must
 * sit inside a <Suspense> boundary, otherwise it blocks the whole route from
 * rendering and the build fails. The static shell renders immediately; only the
 * region-specific line streams in.
 */
export default function RestrictedPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Trading unavailable</h1>

      <Suspense
        fallback={
          <p className="text-base opacity-80">
            Checking availability in your region…
          </p>
        }
      >
        <RegionDetail />
      </Suspense>

      <p className="text-sm opacity-60">
        This restriction is set by the underlying market venue, not by this
        platform. Orders from restricted regions are rejected at the exchange.
      </p>
    </main>
  );
}

async function RegionDetail() {
  // Next 16: headers() is async-only.
  const headerList = await headers();
  const tier = (headerList.get("x-geo-tier") ?? "blocked") as GeoTier;
  const country = headerList.get("x-geo-country");

  return (
    <>
      <p className="text-base opacity-80">
        {geoExplanation(tier) ||
          "Trading is not available from your current location."}
      </p>
      {country ? (
        <p className="text-sm opacity-60">Detected region: {country}</p>
      ) : null}
    </>
  );
}
