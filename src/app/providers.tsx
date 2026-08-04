"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { polygon } from "viem/chains";

import { PRIVY_APP_ID, isAuthConfigured } from "@/lib/auth/public-config";

/**
 * Client-side auth provider (FR-1.1).
 *
 * Privy's embedded wallet is what signs orders — Polymarket ships a first-party
 * `@polymarket/client/privy` signer that consumes it directly, which is why
 * Privy was chosen (OI-4).
 *
 * When P-6 is absent the provider is skipped entirely rather than mounted with
 * an empty app id: Privy throws on an invalid id, which would take down every
 * page instead of just the login button. Mock mode must keep rendering.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  if (!isAuthConfigured) return <>{children}</>;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // Email only for now. Social logins are a dashboard toggle plus an
        // entry here; no code change beyond this array.
        loginMethods: ["email"],

        // The embedded wallet is the user's signer. Without it there is no
        // Deposit Wallet and no order signing, so it is created at login
        // rather than lazily.
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },

        // Polymarket is Polygon-only. Constraining this stops the wallet from
        // ever being pointed at a chain where the CTF contracts do not exist.
        defaultChain: polygon,
        supportedChains: [polygon],

        appearance: {
          theme: "dark",
          landingHeader: "Sign in to trade",
          loginMessage: "Prediction markets, powered by Polymarket.",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
