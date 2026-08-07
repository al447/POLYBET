import { Suspense } from "react";

import { GeoBanner } from "@/components/geo/geo-banner";
import { ReadinessPanel } from "@/components/status/readiness-panel";
import { RightSidebar } from "@/components/layout/right-sidebar";
import { DiscoverySection, DiscoverySectionSkeleton } from "@/components/markets/discovery-section";

/**
 * Home page: sign in, provision a Deposit Wallet, add funds, browse markets.
 *
 * Milestone 2 added market discovery (`DiscoverySection`) below the
 * Milestone 1 onboarding surface; the trading ticket is still to come
 * (Milestone 3 — cards link out to polymarket.com's own event page for now).
 *
 * Two-column shell (main content + right info rail) matching the site's nav
 * bar pattern — see `RightSidebar` for what moved there and why.
 *
 * Every server panel here reads request-scoped data (`headers()`, the
 * Cloudflare env, or in DiscoverySection's case `useSearchParams()` further
 * down the tree) — Cache Components treats that as uncached. Each needs its
 * own <Suspense> boundary or the build fails with "Uncached data was
 * accessed outside of <Suspense>". The static shell prerenders; these stream
 * in.
 */
export default function Home() {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-12 lg:grid lg:grid-cols-[1fr_360px] lg:items-start lg:gap-6">
      <main>
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            Prediction Markets
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Trade on Polymarket liquidity. Your wallet, your keys — deposits
            and positions stay under your own signer.
          </p>
        </header>

        <div className="mb-6">
          <Suspense fallback={null}>
            <GeoBanner />
          </Suspense>
        </div>

        <div className="mb-8">
          <Suspense
            fallback={
              <div className="h-32 rounded-xl border border-zinc-800 bg-zinc-900/40" />
            }
          >
            <ReadinessPanel />
          </Suspense>
        </div>

        <Suspense fallback={<DiscoverySectionSkeleton />}>
          <DiscoverySection />
        </Suspense>
      </main>

      <div className="mt-8 lg:mt-0">
        <Suspense fallback={<div className="h-96 rounded-xl border border-zinc-800 bg-zinc-900/40" />}>
          <RightSidebar />
        </Suspense>
      </div>
    </div>
  );
}
