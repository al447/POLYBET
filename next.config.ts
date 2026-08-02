import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Next 16 caching model. Everything is dynamic by default; caching is opt-in
  // via `use cache`. This is the polarity we want: in a trading UI a stale price
  // is a correctness bug, not a slow page.
  cacheComponents: true,

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
