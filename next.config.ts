import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const isDev = process.env.NODE_ENV === "development";

/**
 * 🚩 Flip to `true` only after report-only has run clean through a real Privy
 * login AND a real order signature in a DEPLOYED Worker (deployment.md, Phase
 * 3.2). A CSP regression here does not present as a CSP error anyone sees — it
 * presents as a login that silently does nothing, which is indistinguishable
 * from the `NEXT_PUBLIC_PRIVY_APP_ID` build-time trap. Do not flip it blind.
 */
const CSP_ENFORCE = false;

/**
 * Content Security Policy (SEC-6).
 *
 * Derived from the app's actual network surface, not copied from a template:
 * `lib/polymarket/config.ts` for the Polymarket endpoints, Privy's dist bundle
 * for its auth origins, and `lib/polymarket/browser-client.ts` for what the
 * browser genuinely talks to. Re-derive it when either changes.
 *
 * Honest about its own weak point: `script-src` carries `'unsafe-inline'`
 * because Next's hydration bootstrap is an inline script, so this policy is NOT
 * meaningful XSS protection today. The upgrade is per-request nonces emitted
 * from `middleware.ts` — deferred because the gate already runs on every
 * request and a nonce bug there takes down the whole site.
 *
 * What it *does* buy, and why it is worth shipping regardless:
 *   - `connect-src`  a compromised dependency cannot exfiltrate to an arbitrary
 *                    host. On a trading app this is the directive that matters.
 *   - `frame-ancestors 'none'`  clickjacking. Critical: this UI signs orders,
 *                    and a transparent overlay over a "Buy" button spends money.
 *   - `form-action` / `base-uri`  blocks the classic redirect and base-tag
 *                    hijacks that survive most XSS filters.
 */
const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],

  // 'unsafe-inline' — see above. 'unsafe-eval' is dev-only (Turbopack HMR);
  // it must never reach production.
  "script-src": ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],

  // Tailwind and Privy's theming both inject style attributes at runtime.
  "style-src": ["'self'", "'unsafe-inline'"],

  // Self-hosted (`src/app/fonts/`) precisely so no external font host is needed
  // — see the `next/font/google` trap in CLAUDE.md.
  "font-src": ["'self'", "data:"],

  "img-src": [
    "'self'",
    "data:",
    "blob:",
    // Mirrors images.remotePatterns below; the two must stay in step.
    "https://polymarket-upload.s3.us-east-2.amazonaws.com",
    "https://polymarket.com",
    "https://*.privy.io",
  ],

  "connect-src": [
    "'self'",
    // Polymarket REST — lib/polymarket/config.ts POLYMARKET_ENDPOINTS.
    "https://clob.polymarket.com",
    "https://gamma-api.polymarket.com",
    "https://data-api.polymarket.com",
    "https://relayer-v2.polymarket.com",
    "https://polymarket.com",
    // Polymarket WSS — POLYMARKET_WS. Not used until Milestone 3, but listed
    // now so the order book does not arrive blocked by a policy nobody links
    // to the failure.
    "wss://ws-subscriptions-clob.polymarket.com",
    "wss://ws-live-data.polymarket.com",
    "wss://sports-api.polymarket.com",
    // Privy auth + its RPC proxy. The browser reaches Polygon through Privy's
    // EIP-1193 provider (`custom(provider)` in browser-client.ts), NOT through
    // POLYGON_RPC_URL — that is a server-side secret and never a browser
    // origin, so it deliberately does not appear here.
    "https://auth.privy.io",
    "https://*.privy.io",
    "https://*.rpc.privy.systems",
    ...(isDev ? ["ws://localhost:*", "http://localhost:*"] : []),
  ],

  // Privy renders the embedded wallet — the thing that holds the user's signing
  // key — in an iframe. Without this, login completes but signing cannot.
  "frame-src": ["'self'", "https://auth.privy.io", "https://*.privy.io"],

  "worker-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  ...(isDev ? {} : { "upgrade-insecure-requests": [] }),
};

const cspValue = Object.entries(CSP_DIRECTIVES)
  .map(([directive, values]) => (values.length ? `${directive} ${values.join(" ")}` : directive))
  .join("; ");

const securityHeaders = [
  {
    key: CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    value: cspValue,
  },
  // Belt-and-braces with frame-ancestors, for anything that predates CSP L2.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Referrers must not leak market//position paths to third parties.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // Cross-origin isolation, minus COEP — COEP breaks Privy's iframe.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          // HSTS is production-only: sending it from `next dev` over http is a
          // no-op, but sending it from a local HTTPS proxy pins localhost to
          // HTTPS in your browser for a year and is painful to undo.
          ...(isDev
            ? []
            : [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]),
        ],
      },
    ];
  },

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
