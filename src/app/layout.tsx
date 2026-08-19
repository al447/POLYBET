import type { Metadata } from "next";
import localFont from "next/font/local";

import { Providers } from "./providers";
import { NavBar } from "@/components/layout/nav-bar";
import { SiteFooter } from "@/components/layout/site-footer";
import { AcceptanceGate } from "@/components/legal/acceptance-gate";
import "./globals.css";

/**
 * Fonts are self-hosted, not fetched from Google at build time.
 *
 * `next/font/google` resolves over the network during `next build`, which makes
 * every production build — and every CI run and deploy — depend on
 * fonts.googleapis.com being reachable. That is a real failure mode, not a
 * hypothetical: a transient blip failed a build here on 2026-08-04 with
 * "Failed to fetch `Geist` from Google Fonts", for reasons unrelated to the code
 * being deployed.
 *
 * These are the same latin-subset variable files Google was serving, committed
 * to the repo. Geist is Vercel's typeface under the SIL Open Font License, so
 * redistribution is permitted. Builds are now offline-capable and reproducible.
 *
 * `weight` is a RANGE because these are variable fonts — a single value would
 * throw away every weight but one.
 */
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

/**
 * `metadataBase` is hardcoded rather than read from an env var on purpose.
 *
 * Next resolves the `opengraph-image` file convention *relative* to this. With
 * it unset the built page emits a localhost URL and every shared link unfurls
 * broken. A `NEXT_PUBLIC_*` var would work but reintroduces the build-time trap
 * documented in `.env.example` — it has to be exported before
 * `opennextjs-cloudflare build`, and forgetting it fails silently.
 *
 * The `template` brands every child page's tab. Routes that export a bare
 * `title` (copy-trade, predict-ai, leaderboard, terms, risk-disclosure) render
 * as "Copy Trading · Polybets" through it; without one they render unbranded.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://polybets.xyz"),
  title: {
    default: "Polybets — Prediction Markets",
    template: "%s · Polybets",
  },
  description:
    "Polybets is a self-custodial interface to prediction markets on Polymarket liquidity — you hold your own keys.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-zinc-950 text-zinc-100">
        <Providers>
          <NavBar />
          {/*
            Only `children` is gated (FR-6.4). The nav and footer stay outside
            deliberately — the footer carries the links to the very documents
            the gate asks the user to accept, so burying them behind it would
            be circular.
          */}
          <AcceptanceGate>{children}</AcceptanceGate>
          {/* `mt-auto` on the footer pins it to the bottom on short pages — body is already flex-col min-h-full. */}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
