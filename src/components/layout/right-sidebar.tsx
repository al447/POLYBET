import type { ReactNode } from "react";

import { AccountPanel } from "@/components/auth/account-panel";
import { DepositWalletPanel } from "@/components/wallet/deposit-wallet-panel";
import { Card } from "@/components/ui/primitives";
import { ClockIcon, StarIcon, TrendingIcon } from "@/components/ui/icons";

/**
 * Right info rail (implementation.md UI shell), home page only.
 *
 * Card order matches the reference pattern: identity, then wallet/funds, then
 * discovery-adjacent widgets. `AccountPanel` and `DepositWalletPanel` are
 * unchanged — only relocated here from the old single-column layout — and
 * `DepositWalletPanel` keeps its own "Deposit Wallet" title rather than being
 * relabeled "Portfolio": there is no positions/PnL calculation yet (that's
 * Milestone 4), so the existing label is the honest one.
 *
 * Watchlist / Trending Topics / Recent Activity have no backend yet
 * (Milestone 2+). They render as plain empty states rather than fabricated
 * data — same convention as `AuthNotConfigured` / `WalletUnavailable`.
 */
export function RightSidebar() {
  return (
    <aside className="flex flex-col gap-4">
      <AccountPanel />
      <DepositWalletPanel />

      <InfoPlaceholderCard
        icon={<StarIcon className="size-5" />}
        title="Watchlist"
        description="Market watchlists land with discovery in Milestone 2 — nothing to show yet."
      />
      <InfoPlaceholderCard
        icon={<TrendingIcon className="size-5" />}
        title="Trending topics"
        description="No market data source is wired up yet — trending topics come with the Gamma discovery engine."
      />
      <InfoPlaceholderCard
        icon={<ClockIcon className="size-5" />}
        title="Recent activity"
        description="Your trade history will appear here once order placement ships in Milestone 3."
      />
    </aside>
  );
}

function InfoPlaceholderCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card title={title}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-zinc-600">{icon}</span>
        <p className="text-sm text-zinc-500">{description}</p>
      </div>
    </Card>
  );
}
