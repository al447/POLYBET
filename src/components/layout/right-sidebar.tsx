import type { ReactNode } from "react";

import { AccountPanel } from "@/components/auth/account-panel";
import { DepositWalletPanel } from "@/components/wallet/deposit-wallet-panel";
import { Card } from "@/components/ui/primitives";
import { ClockIcon, StarIcon } from "@/components/ui/icons";
import { TOP_CATEGORIES } from "@/lib/polymarket/gamma-types";

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
 * `TrendingTopicsCard` went live with the Gamma discovery engine (Milestone
 * 2), reading the same curated `TOP_CATEGORIES` list the discovery grid's
 * chips use — see gamma-types.ts. Watchlist and Recent Activity still have no
 * backend (personalized watchlists aren't in any FR yet; trade history is
 * Milestone 3) and stay plain empty states, same convention as
 * `AuthNotConfigured` / `WalletUnavailable`.
 */
export function RightSidebar() {
  return (
    <aside className="flex flex-col gap-4">
      <AccountPanel />
      <DepositWalletPanel />

      <InfoPlaceholderCard
        icon={<StarIcon className="size-5" />}
        title="Watchlist"
        description="Personal market watchlists aren't built yet — nothing to show."
      />
      <TrendingTopicsCard />
      <InfoPlaceholderCard
        icon={<ClockIcon className="size-5" />}
        title="Recent activity"
        description="Your trade history will appear here once order placement ships in Milestone 3."
      />
    </aside>
  );
}

function TrendingTopicsCard() {
  return (
    <Card title="Trending topics">
      <ul className="flex flex-wrap gap-2">
        {TOP_CATEGORIES.map((tag) => (
          <li key={tag.id}>
            <a
              href={`/?tagId=${tag.id}`}
              className="rounded-full border border-zinc-800 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
            >
              {tag.label}
            </a>
          </li>
        ))}
      </ul>
    </Card>
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
