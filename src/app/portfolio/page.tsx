import { PortfolioView } from "@/components/portfolio/portfolio-view";

/**
 * Portfolio page (FR-4.1–4.3, implementation.md Step 4.2).
 *
 * A thin server shell only — unlike `/` and `/market/[slug]`, there is no
 * server-side fetch here and no <Suspense> boundary to stream: positions are
 * read in the browser from the user's own authenticated client, because the
 * server never learns the Deposit Wallet address that the Data API needs.
 * See `lib/polymarket/portfolio.ts` for the full reasoning.
 *
 * Not yet here: trade history (FR-4.4), withdrawals (FR-4.6), rewards
 * (FR-5.2/5.3), and live updates from the user WebSocket (FR-4.5).
 */
export default function PortfolioPage() {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Your open positions, what they cost, and what they&apos;re worth now. Held in your own
          Deposit Wallet — we never take custody.
        </p>
      </header>

      <PortfolioView />
    </div>
  );
}
