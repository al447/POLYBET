"use client";

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

import { FollowDialog } from "@/components/copy-trade/follow-dialog";
import { useCopyEngineContext } from "@/components/copy-trade/copy-engine-provider";
import { isAuthConfigured } from "@/lib/auth/public-config";
import type { CopySettings } from "@/lib/copy-trade/types";

/**
 * The one place that decides what a "Copy trader" button does.
 *
 * | State                    | Behaviour                                        |
 * |--------------------------|--------------------------------------------------|
 * | Privy not set up         | Disabled, explains that P-6 is missing            |
 * | Signed out               | Opens the login modal                             |
 * | Signed in, engine ready  | Opens `FollowDialog` to set caps, then follows     |
 * | Signed in, already following | Says so; stopping is done from the dashboard   |
 *
 * 🚩 The signed-in branch used to refuse outright, on the grounds that
 * mirroring trades needs server-held delegated signing (OI-5). That reasoning
 * was about a *server-side* copier and still holds for one. What changed is
 * where the engine runs: it is a loop in this browser tab, using the wallet the
 * user is already signed in with, and **every copy still waits for an explicit
 * click** before anything is signed. No delegation is requested, no key is held
 * server-side, and nothing happens when the tab is closed — so the
 * "your wallet, your keys" promise on the home page is intact.
 *
 * What is still *not* resolved is hands-off auto-signing, which would need
 * Privy's confirmation modals disabled globally. That remains a product and
 * legal decision, and nothing here quietly leans toward it.
 *
 * `isAuthConfigured` is read at module scope from a build-time inlined
 * `NEXT_PUBLIC_*`, so this whole component is inert in mock mode rather than
 * offering a login that cannot succeed.
 */

type Variant = "hero" | "card";

const STYLES: Record<Variant, string> = {
  hero: "rounded-lg px-6 py-3 text-base font-semibold",
  card: "w-full rounded-lg px-4 py-2.5 text-sm font-semibold",
};

type CopyCtaProps = {
  variant?: Variant;
  label?: string;
  /** Absent on the hero button, which has no single trader in mind. */
  trader?: { address: string; name: string; avatar?: string };
};

export function CopyCta({ variant = "card", label = "Copy trader", ...rest }: CopyCtaProps) {
  // Hooks live in the inner component so they are never called without a
  // PrivyProvider ancestor, which throws. Same split as `AccountPanel` —
  // `Providers` skips the provider entirely in mock mode, so a `usePrivy()`
  // above this guard would take down every page that renders a copy button
  // rather than just disabling the button.
  if (!isAuthConfigured) {
    return (
      <button
        type="button"
        disabled
        title="Login is unavailable until the Privy credentials (P-6) are supplied."
        className={`cursor-not-allowed bg-zinc-800 text-zinc-500 ${STYLES[variant]}`}
      >
        {label}
      </button>
    );
  }

  return <PrivyCopyCta variant={variant} label={label} {...rest} />;
}

function PrivyCopyCta({ variant = "card", label = "Copy trader", trader }: CopyCtaProps) {
  const { ready, authenticated, login } = usePrivy();
  const engine = useCopyEngineContext();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Privy resolves the session asynchronously. Rendering the button disabled
  // rather than absent keeps the card height stable — a grid of six cards
  // reflowing on hydration is worse than a button that's briefly inert.
  if (!ready) {
    return (
      <button
        type="button"
        disabled
        className={`cursor-wait bg-blue-600/50 text-white/70 ${STYLES[variant]}`}
      >
        {label}
      </button>
    );
  }

  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={login}
        className={`cursor-pointer bg-blue-600 text-white transition hover:bg-blue-500 ${STYLES[variant]}`}
      >
        {label}
      </button>
    );
  }

  // Signed in, but this button is not tied to a trader (the hero) or is being
  // rendered outside a provider. Nothing to follow, so send them to the board.
  if (!trader || !engine) {
    return (
      <a
        href="/leaderboard"
        className={`inline-block cursor-pointer bg-blue-600 text-center text-white transition hover:bg-blue-500 ${STYLES[variant]}`}
      >
        {label}
      </a>
    );
  }

  const following = engine.follows.some(
    (entry) => entry.address === trader.address.toLowerCase(),
  );

  if (following) {
    return (
      <button
        type="button"
        disabled
        className={`cursor-default border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 ${STYLES[variant]}`}
      >
        Copying
      </button>
    );
  }

  // Not named `confirm` — that shadows the global of the same name, which is
  // exactly the sort of thing that reads fine and behaves oddly later.
  function handleConfirm(settings: CopySettings) {
    if (!trader || !engine) return;
    engine.followTrader(trader, settings);
    setDialogOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className={`cursor-pointer bg-blue-600 text-white transition hover:bg-blue-500 ${STYLES[variant]}`}
      >
        {label}
      </button>

      {dialogOpen ? (
        <FollowDialog
          trader={trader}
          onConfirm={handleConfirm}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
