import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // ⚠️ `cacheComponents: true` is unusable here — it makes every page 500 on
  // workerd under @opennextjs/cloudflare (see CLAUDE.md). Verified 2026-08-04
  // on 1.20.2, the latest release; there is no canary and no config toggle.
  //
  // Turning it off costs less than it sounds. Every page in this app reads
  // `cookies()` (auth) and `headers()` (geo), so Next marks them fully dynamic
  // regardless — measured: with the flag off, `/` and `/restricted` go from
  // `◐ Partial Prerender` to `ƒ Dynamic`, and NOTHING becomes static. So we
  // lose the streaming static shell, not correctness. A stale price remains
  // impossible by default.
  cacheComponents: false,

  experimental: {
    // Keeps `use cache` / `cacheLife` / `cacheTag` available without the
    // Cache Components rendering model that breaks OpenNext. Milestone 2 needs
    // these for Gamma market data; caching stays explicit and opt-in, which was
    // the point of choosing this polarity in the first place.
    useCache: true,
  },

  images: {
    // images.domains is deprecated in Next 16.
    remotePatterns: [
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "polymarket.com" },
    ],
  },

  typescript: { ignoreBuildErrors: false },
};

// Gives `getCloudflareContext()` real local bindings during `next dev`.
void initOpenNextCloudflareForDev();

export default nextConfig;
