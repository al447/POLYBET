import { TraderAvatar } from "@/components/ui/avatar";
import { CopyCta } from "@/components/copy-trade/copy-cta";
import { formatUsd, formatUsdExact, shortenAddress } from "@/lib/format";
import type { LeaderboardTrader } from "@/lib/polymarket/leaderboard-types";

/**
 * One trader tile on the copy-trade page.
 *
 * A server component — only the button inside it needs client hooks, same
 * split used everywhere else here (`NavBar` / `PrivyAuthArea`).
 *
 * The two money figures are formatted differently on purpose. P&L is exact
 * (`$287,429.03`) because it is the number the card is making a claim about;
 * volume is compact (`$2.3M`) because it is context. Both come from
 * `lib/format.ts` so they read the same as everywhere else in the app.
 *
 * `periodLabel` is passed in rather than hardcoded as "7d": the same card is
 * reused under other windows, and a mislabelled P&L window is the kind of
 * wrong that looks completely fine.
 */
export function TraderCard({
  trader,
  periodLabel,
}: {
  trader: LeaderboardTrader;
  periodLabel: string;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-sm font-medium text-zinc-500">#{trader.rank}</span>
        <TraderAvatar src={trader.avatar} name={trader.name} seed={trader.address} size={40} />

        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-100" title={trader.name}>
            {trader.name}
          </h3>
          {/* The address is shown even when the name is already a shortened
              address — it's the one identifier that's always unambiguous, and
              the `title` carries the full value for copying. */}
          <p className="truncate font-mono text-xs text-zinc-500" title={trader.address}>
            {shortenAddress(trader.address)}
          </p>
        </div>
      </div>

      <dl className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <dt className="text-xs text-zinc-500">P&amp;L ({periodLabel})</dt>
          <dd
            className={`truncate text-lg font-semibold ${
              trader.pnl < 0 ? "text-red-400" : "text-emerald-400"
            }`}
          >
            {formatUsdExact(trader.pnl)}
          </dd>
        </div>

        <div className="shrink-0 text-right">
          <dt className="text-xs text-zinc-500">Volume</dt>
          {/* `$0` is real data on this board, not a missing value — several
              top-PnL traders genuinely traded no notional in the window. */}
          <dd className="text-lg font-semibold text-zinc-100">{formatUsd(trader.volume)}</dd>
        </div>
      </dl>

      {/* The address, not just the name, is what the engine follows — two
          traders can share a display name, and an unnamed one falls back to a
          shortened address that is not the address itself. */}
      <CopyCta
        trader={{ address: trader.address, name: trader.name, avatar: trader.avatar }}
      />
    </article>
  );
}
