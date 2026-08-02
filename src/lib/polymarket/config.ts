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
 * A GTD limit order's expiry must be at least 3 minutes out per the SDK.
 * We add headroom for clock skew and network latency.
 */
export const MIN_GTD_EXPIRY_SECONDS = 180;
export const GTD_EXPIRY_BUFFER_SECONDS = 60;
