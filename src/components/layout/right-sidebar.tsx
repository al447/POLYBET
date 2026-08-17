import type { ReactNode } from "react";
import Link from "next/link";

import { AccountPanel } from "@/components/auth/account-panel";
import { DepositWalletPanel } from "@/components/wallet/deposit-wallet-panel";
import { Card } from "@/components/ui/primitives";
import { ClockIcon, SparkleIcon, StarIcon, UsersIcon } from "@/components/ui/icons";
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
      <PromoCard
        tone="blue"
        icon={<UsersIcon className="size-5" />}
        title="Copy top traders"
        description="Mirror any leaderboard trader, sized to your own limits."
        cta="Start copying"
        href="/copy-trade"
      />
      <PromoCard
        tone="amber"
        icon={<SparkleIcon className="size-5" />}
        title="Predict AI"
        description="Predict Sports using Predict AI."
        cta="Predict Sports"
      />

      <AccountPanel />
      <DepositWalletPanel />

      <InfoPlaceholderCard
        icon={<StarIcon className="size-5" />}
        title="Watchlist"
        description="Personal market watchlists aren't built yet — nothing to show."
      />
      <TrendingTopicsCard />
      <RecentActivityCard />
    </aside>
  );
}

/**
 * Points at the activity page rather than duplicating the feed here.
 *
 * The trade-by-trade history (FR-4.4, `listActivity`) now exists, but it reads
 * from the user's *authenticated* client — this sidebar renders on every page
 * including signed-out ones, so mounting it here would mean a second
 * `SecureClient` connection and an L1 signature prompt just to fill a sidebar
 * card. The link is the honest version.
 */
function RecentActivityCard() {
  return (
    <Card title="Recent activity">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-zinc-600">
          <ClockIcon className="size-5" />
        </span>
        <p className="text-sm text-zinc-500">
          Your trades, redemptions and rewards are on the{" "}
          <a href="/activity" className="text-emerald-400 underline underline-offset-2">
            activity page
          </a>
          .
        </p>
      </div>
    </Card>
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

/**
 * Copy Trading and Predict AI, as the reference design presents them: tinted
 * promo cards at the top of the rail.
 *
 * **With `href`, the card is a real link; without it, the button is visibly
 * disabled and says why on hover** — the same convention as the hamburger
 * menu's placeholder rows. Advertising the roadmap is fine; a button that
 * silently fails is not.
 *
 * Copy Trading gained an `href` on 2026-08-17 when `/copy-trade` landed. That
 * page is a landing page over live leaderboard data — the copy *engine* is
 * still blocked on the custody question (OI-5), since auto-executing on a
 * user's behalf needs server-held delegated signing and this platform is
 * non-custodial by design. Predict AI has no page at all and keeps the
 * disabled button.
 *
 * They sit above `AccountPanel` to match the reference's ordering. Worth
 * revisiting if it turns out to push the deposit flow too far down for
 * first-time users — promotion for features that don't exist yet outranking
 * the one that funds the account is a trade, not a free win.
 */
function PromoCard({
  tone,
  icon,
  title,
  description,
  cta,
  href,
}: {
  tone: "blue" | "amber";
  icon: ReactNode;
  title: string;
  description: string;
  cta: string;
  /** Omit for a feature with no page yet — the button renders disabled. */
  href?: string;
}) {
  const palette =
    tone === "blue"
      ? {
          frame: "border-blue-500/30 bg-blue-500/5",
          glyph: "text-blue-400",
          button: "bg-blue-600 text-white",
        }
      : {
          frame: "border-amber-500/30 bg-amber-500/5",
          glyph: "text-amber-400",
          button: "bg-amber-500 text-black",
        };

  return (
    <section className={`rounded-xl border p-5 ${palette.frame}`}>
      <div className="flex items-center gap-2.5">
        <span className={palette.glyph}>{icon}</span>
        <h2 className="text-base font-semibold tracking-tight text-zinc-100">{title}</h2>
      </div>

      <div className="mt-2 flex items-end justify-between gap-4">
        <p className="text-sm text-zinc-400">{description}</p>
        {href ? (
          <Link
            href={href}
            className={`shrink-0 rounded-lg px-3.5 py-2 text-sm font-semibold transition hover:opacity-90 ${palette.button}`}
          >
            {cta}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            title="Coming soon"
            className={`shrink-0 cursor-not-allowed rounded-lg px-3.5 py-2 text-sm font-semibold opacity-60 ${palette.button}`}
          >
            {cta}
          </button>
        )}
      </div>
    </section>
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
