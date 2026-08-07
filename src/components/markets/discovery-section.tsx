import { getCachedEvents } from "@/lib/polymarket/gamma";
import { TOP_CATEGORIES } from "@/lib/polymarket/gamma-types";
import { MarketGrid } from "@/components/markets/market-grid";

/**
 * Server-side entry point for the discovery grid (FR-2.1, FR-2.5).
 *
 * Calls the same cached function `/api/markets` uses, directly — a Server
 * Component fetching Gamma data itself is fine (the "never call Gamma from
 * the browser" rule is about client-side fetches); this just avoids an
 * unnecessary self-HTTP round trip for the first paint. `MarketGrid` takes it
 * from there client-side for pagination/filtering. Category chips come from
 * the curated `TOP_CATEGORIES` list, not a live tags fetch — see its comment
 * in gamma-types.ts for why.
 */
export async function DiscoverySection() {
  const page = await getCachedEvents({ limit: 24 });

  if (!page.ok) {
    return (
      <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-6 text-center text-sm text-red-300">
        Couldn&apos;t load markets right now ({page.error}). Try refreshing.
      </p>
    );
  }

  return (
    <MarketGrid initialEvents={page.items} initialCursor={page.nextCursor} tags={TOP_CATEGORIES} />
  );
}

export function DiscoverySectionSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-40 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
      ))}
    </div>
  );
}
