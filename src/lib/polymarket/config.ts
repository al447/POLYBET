/**
 * Polymarket endpoints and protocol constants.
 * Verified against docs.polymarket.com on 2026-08-02.
 *
 * Polymarket shipped breaking infrastructure changes in April-May 2026.
 * Re-verify these each milestone rather than trusting them indefinitely.
 */

export const POLYMARKET_ENDPOINTS = {
  gamma: "https://gamma-api.polymarket.com",
  clob: "https://clob.polymarket.com",
  data: "https://data-api.polymarket.com",
  relayer: "https://relayer-v2.polymarket.com",
  geoblock: "https://polymarket.com/api/geoblock",
} as const;

export const POLYMARKET_WS = {
  market: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  user: "wss://ws-subscriptions-clob.polymarket.com/ws/user",
  liveData: "wss://ws-live-data.polymarket.com",
  sports: "wss://sports-api.polymarket.com/ws",
} as const;

/** Polygon mainnet. */
export const CHAIN_ID = 137;

/**
 * Deposit Wallet factory. Deposit Wallets (ERC-1967 beacon proxy) are the
 * current standard for accounts created on or after 2026-05-04 and replace the
 * legacy Gnosis Safe / Proxy wallets the original SRS specified.
 */
export const DEPOSIT_WALLET_FACTORY =
  "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07" as const;

/**
 * Builder fee caps, enforced by Polymarket. Exceeding them is rejected upstream.
 */
export const FEE_CAPS_BPS = {
  taker: 100, // 1.00%
  maker: 50, //  0.50%
} as const;

/** Collateral is pUSD (1:1 USDC-backed), 6 decimals, not USDC directly. */
export const COLLATERAL = {
  symbol: "pUSD",
  decimals: 6,
  /** What users actually deposit; converted to pUSD on arrival. */
  depositSymbol: "USDC",
} as const;

/**
 * Polymarket's Bridge API — the withdrawal path (FR-4.6). The SDK does NOT
 * wrap this; `withdrawFromPerps` is a different, perps-only endpoint on a
 * different host. Flow: `/quote` → `/withdraw` (returns a bridge address) →
 * transfer pUSD to that address → `/status/{address}`.
 */
export const BRIDGE_ENDPOINT = "https://bridge.polymarket.com";

/**
 * 🚩 Fund-moving addresses. **Verified live against
 * `bridge.polymarket.com/supported-assets` on 2026-08-09** — not copied from
 * a doc page, because the docs' own prose misidentifies the pUSD address as
 * "the Polygon USDC address". Sending to the wrong one turns a withdrawal
 * into a pUSD→pUSD round trip.
 *
 * `withdraw.ts` re-checks these against the live asset list before every
 * withdrawal and refuses if they've drifted — the one code path where a
 * stale constant costs real money.
 */
export const POLYGON_TOKENS = {
  /** Polymarket USD — what the Deposit Wallet holds, and what we send. */
  pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  /** Native USDC on Polygon — what the user receives. NOT USDC.e. */
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
} as const;

/** `minCheckoutUsd` from the live asset list, 2026-08-09. Enforced client-side so a doomed transfer is never signed. */
export const MIN_WITHDRAWAL_USD = 2;

/**
 * A GTD limit order's expiry must be at least 3 minutes out per the SDK.
 * We add headroom for clock skew and network latency.
 */
export const MIN_GTD_EXPIRY_SECONDS = 180;
export const GTD_EXPIRY_BUFFER_SECONDS = 60;

/**
 * Preset GTD durations offered in the trading panel — deliberately not a
 * free-form date/time picker, to stay dependency-free and cover the
 * realistic range for a prediction-market limit order.
 */
export const GTD_DURATIONS_SECONDS = {
  "1h": 3_600,
  "1d": 86_400,
  "1w": 604_800,
} as const;
export type GtdDuration = keyof typeof GTD_DURATIONS_SECONDS;

/**
 * Unix-seconds expiration for a GTD limit order. Floored at
 * `MIN_GTD_EXPIRY_SECONDS` out as a defensive minimum — every preset here is
 * already far past that, but a future shorter preset shouldn't be able to
 * produce an expiry the SDK rejects.
 */
export function computeGtdExpiration(duration: GtdDuration, nowSeconds: number): number {
  return Math.max(
    nowSeconds + GTD_EXPIRY_BUFFER_SECONDS + GTD_DURATIONS_SECONDS[duration],
    nowSeconds + MIN_GTD_EXPIRY_SECONDS,
  );
}
