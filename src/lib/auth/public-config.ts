/**
 * Browser-safe auth configuration.
 *
 * Deliberately NOT `server-only` — this is the one piece of auth config the
 * client bundle is allowed to contain. The Privy app id is public by design
 * (it identifies the app in Privy's API); the app *secret* lives in
 * `lib/env.ts` and never crosses this boundary.
 *
 * `NEXT_PUBLIC_*` is read as a literal rather than through a dynamic key
 * because Next inlines these at build time and only recognises static access.
 */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

/**
 * Whether login can work at all in this deployment.
 *
 * False until the client supplies P-6, which is the normal state in mock mode.
 * The UI degrades to an explanatory panel rather than a login button that
 * cannot succeed.
 */
export const isAuthConfigured = PRIVY_APP_ID.length > 0;

/** Polygon Mainnet — the only chain this platform trades on. */
export const CHAIN_ID = 137;

/**
 * Builder code (P-1) for order attribution.
 *
 * Safe in the client bundle, unlike every other builder credential: the code is
 * written into the signed order struct and emitted in the on-chain
 * `OrderFilled` event, so it is already public. The API key, secret and
 * passphrase are not, and never cross this boundary — see
 * `app/api/builder/sign`.
 *
 * Build-time inlined like any NEXT_PUBLIC_* value, so it must come from
 * `.env.local` or a CI build variable — NOT `.dev.vars`, which Next never reads
 * for these.
 */
export const BUILDER_CODE = process.env.NEXT_PUBLIC_POLYMARKET_BUILDER_CODE ?? "";

/** Whether the browser can build and sign an attributed order. */
export const isTradingConfigured = isAuthConfigured && BUILDER_CODE.length > 0;
