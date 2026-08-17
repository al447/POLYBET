"use client";

import type { ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";

import { CopyDashboard } from "@/components/copy-trade/copy-dashboard";
import { CopyEngineProvider } from "@/components/copy-trade/copy-engine-provider";
import { isAuthConfigured } from "@/lib/auth/public-config";

/**
 * Chooses between the marketing landing page and the signed-in dashboard.
 *
 * Both `landing` and `traders` arrive as **already-rendered server nodes**, so
 * this switch ships no page content of its own — the marketing copy and the
 * live leaderboard are still server-rendered, and only the decision about which
 * to show is client-side. Rewriting either as a client component would put the
 * leaderboard fetch in the browser and undo the caching behind it.
 *
 * `traders` appears in both branches. It is the same node either way; React
 * renders it wherever it is placed.
 *
 * The mock-mode guard mirrors `Providers` and `CopyCta`: with no Privy app id
 * there is no `<PrivyProvider>` mounted, so `usePrivy` would throw and take the
 * whole page down rather than degrading to the landing view.
 */
export function CopyTradeShell({
  landing,
  traders,
}: {
  landing: ReactNode;
  traders: ReactNode;
}) {
  if (!isAuthConfigured) return <>{landing}</>;
  return <AuthedShell landing={landing} traders={traders} />;
}

function AuthedShell({ landing, traders }: { landing: ReactNode; traders: ReactNode }) {
  const { ready, authenticated } = usePrivy();

  // The engine provider wraps both branches so the `Copy trader` buttons on the
  // landing page's own trader cards can reach it the moment a user signs in,
  // without the tree remounting and restarting the poll.
  return (
    <CopyEngineProvider>
      {ready && authenticated ? <CopyDashboard traders={traders} /> : landing}
    </CopyEngineProvider>
  );
}
