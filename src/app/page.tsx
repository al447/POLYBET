import { Suspense } from "react";

import { GeoBanner } from "@/components/geo/geo-banner";
import { ReadinessPanel } from "@/components/status/readiness-panel";
import { RightSidebar } from "@/components/layout/right-sidebar";

/**
 * Milestone 1 surface: sign in, provision a Deposit Wallet, add funds.
 *
 * Market discovery and the trading ticket land in Milestone 2; this page
 * exists to make the onboarding chain visible and testable end to end.
 *
 * Two-column shell (main content + right info rail) matching the site's nav
 * bar pattern — see `RightSidebar` for what moved there and why.
 *
 * Both server panels read request-scoped data (`headers()`, the Cloudflare
 * env), which Cache Components treats as uncached. Each needs its own
 * <Suspense> boundary or the build fails with "Uncached data was accessed
 * outside of <Suspense>". The static shell prerenders; these stream in.
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

        <Suspense
          fallback={
            <div className="h-32 rounded-xl border border-zinc-800 bg-zinc-900/40" />
          }
        >
          <ReadinessPanel />
        </Suspense>
      </main>

      <div className="mt-8 lg:mt-0">
        <RightSidebar />
      </div>
    </div>
  );
}
