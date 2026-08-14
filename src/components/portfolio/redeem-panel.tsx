"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import Link from "next/link";

import { redeemMarketPositions, totalClaimable, type RedeemableMarket } from "@/lib/polymarket/redeem";
import type { BrowserClient } from "@/lib/polymarket/browser-client";
import { Card } from "@/components/ui/primitives";

/**
 * Claim settled winnings on resolved markets.
 *
 * Renders nothing when there is nothing to claim — this is the common case,
 * and an empty "Resolved markets" card on every portfolio load would be pure
 * clutter (same rule as `OpenOrdersPanel`).
 *
 * One button per **condition**, not per position: `groupRedeemable` has
 * already collapsed both sides of a market into a single claim, because
 * `redeemPositions` settles the whole condition at once.
 *
 * Unlike `WithdrawPanel` there is no confirm step, and that asymmetry is
 * deliberate. A withdrawal is irreversible and sends funds to an address the
 * user typed, so it earns an unskippable review. Redeeming only converts
 * already-won outcome tokens into pUSD in the same wallet — there is no
 * destination to get wrong and nothing to lose by doing it. Adding friction
 * would protect against nothing.
 *
 * What it *does* cost is one relay transaction from the daily cap, which is
 * why the button disables in flight rather than relying on the user not to
 * double-click.
 */
export function RedeemPanel({
  client,
  markets,
  onRedeemed,
}: {
  client: BrowserClient;
  markets: RedeemableMarket[];
  onRedeemed: () => void;
}) {
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedId, setClaimedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const claim = useCallback(
    async (conditionId: string) => {
      setClaimingId(conditionId);
      setError(null);
      try {
        await redeemMarketPositions(client, conditionId);
        setClaimedId(conditionId);
        // Reloads positions and cash upstream — the claimed market drops out
        // of this list on the next render, so there's no local removal to do.
        onRedeemed();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't claim this market.");
      } finally {
        setClaimingId(null);
      }
    },
    [client, onRedeemed],
  );

  if (markets.length === 0) return null;

  const total = totalClaimable(markets);

  return (
    <Card
      title="Ready to claim"
      action={
        <span className="text-sm font-semibold tabular-nums text-emerald-400">
          ${total.toFixed(2)}
        </span>
      }
    >
      <div className="space-y-3">
        {markets.map((market) => (
          <ClaimRow
            key={market.conditionId}
            market={market}
            claiming={claimingId === market.conditionId}
            claimed={claimedId === market.conditionId}
            // One claim at a time: each spends relay quota, and a failure is
            // much easier to attribute when only one is in flight.
            disabled={claimingId !== null}
            onClaim={() => void claim(market.conditionId)}
          />
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-xs text-zinc-500">
        Claiming settles your winning shares into pUSD in this wallet. Gas is covered — you don&apos;t
        need POL.
      </p>
    </Card>
  );
}

function ClaimRow({
  market,
  claiming,
  claimed,
  disabled,
  onClaim,
}: {
  market: RedeemableMarket;
  claiming: boolean;
  claimed: boolean;
  disabled: boolean;
  onClaim: () => void;
}) {
  const label = market.title ?? "Untitled market";

  const heading = (
    <div className="flex min-w-0 items-center gap-3">
      {market.icon ? (
        <Image
          src={market.icon}
          alt=""
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-full object-cover"
          unoptimized
        />
      ) : (
        <div className="size-8 shrink-0 rounded-full bg-zinc-800" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-200">{label}</p>
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {market.outcomes.length > 0 ? `${market.outcomes.join(" / ")} · ` : ""}
          {market.shares.toFixed(2)} shares
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex items-center justify-between gap-3">
      {/* Links by eventSlug, not slug — the detail route resolves event slugs, so a market slug 404s. */}
      {market.eventSlug ? (
        <Link href={`/market/${market.eventSlug}`} className="block min-w-0 flex-1">
          {heading}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{heading}</div>
      )}

      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm font-semibold tabular-nums text-zinc-200">
          ${market.payout.toFixed(2)}
        </span>
        <button
          type="button"
          onClick={onClaim}
          disabled={disabled || claimed}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {claiming ? "Claiming…" : claimed ? "Claimed" : "Claim"}
        </button>
      </div>
    </div>
  );
}
