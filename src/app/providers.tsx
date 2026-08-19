"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { polygon } from "viem/chains";

import { PRIVY_APP_ID, isAuthConfigured } from "@/lib/auth/public-config";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

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
          landingHeader: "Sign in to Polybets",
          loginMessage: "Prediction markets, powered by Polymarket.",
        },

        /**
         * FR-6.4 — puts the Terms in front of the user at the moment of signup
         * rather than only being findable afterwards.
         *
         * Relative path, so this follows whatever origin the app is served from
         * and never points at the wrong environment. Privy's config overrides
         * the dashboard's `terms_and_conditions_url`, which keeps the URL in
         * version control next to the page it points at instead of in a
         * dashboard field that silently rots when a route changes.
         *
         * ⚠️ **`privacyPolicyUrl` is deliberately unset, twice over.** Privy
         * offers exactly two slots — terms and privacy policy — and the Risk
         * Disclosure is neither. Pointing the privacy slot at it would render a
         * link labelled "Privacy Policy" that opens a risk warning, which
         * mislabels a legal document to every user at signup. And we have no
         * privacy policy to put there: this app collects an email through Privy
         * and an IP for the geo gate, so one is very likely required
         * (GDPR/UK-GDPR at minimum) — **that is a real gap for the client's
         * counsel, not an oversight to paper over here.**
         *
         * The Risk Disclosure reaches the user through the footer on every page
         * and through the acceptance gate, where it can be labelled correctly.
         *
         * Links only, either way: this is *presentation*, not consent. Privy
         * records nothing about whether the user opened or agreed to anything.
         */
        legal: {
          termsAndConditionsUrl: LEGAL_DOCUMENTS.terms.path,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
