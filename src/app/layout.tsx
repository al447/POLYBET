import type { Metadata } from "next";
import localFont from "next/font/local";

import { Providers } from "./providers";
import { NavBar } from "@/components/layout/nav-bar";
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

export const metadata: Metadata = {
  title: "Prediction Markets",
  description:
    "Trade prediction markets on Polymarket liquidity. Self-custodial — you hold your own keys.",
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
          {children}
        </Providers>
      </body>
    </html>
  );
}
