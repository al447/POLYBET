import { headers } from "next/headers";

import {
  canOpenPositions,
  geoExplanation,
  type GeoTier,
} from "@/lib/geo/jurisdictions";

/**
 * Region status strip (FR-6.2).
 *
 * Reads the tier the middleware already resolved rather than re-fetching it, so
 * rendering a page costs no extra upstream call.
 *
 * Must be rendered inside a <Suspense> boundary: `headers()` is uncached data
 * under Cache Components, and reading it outside one fails the build outright.
 */
export async function GeoBanner() {
  // Next 16: headers() is async-only.
  const headerList = await headers();
  const tier = (headerList.get("x-geo-tier") ?? "allowed") as GeoTier;
  const country = headerList.get("x-geo-country");

  if (tier === "allowed") return null;

  const canTrade = canOpenPositions(tier);

  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        canTrade
          ? "border-zinc-700 bg-zinc-900/60 text-zinc-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-200"
      }`}
      role="status"
    >
      <p>{geoExplanation(tier)}</p>
      {country ? (
        <p className="mt-1 text-xs opacity-60">Detected region: {country}</p>
      ) : null}
    </div>
  );
}
