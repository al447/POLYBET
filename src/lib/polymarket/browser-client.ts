import {
  createSecureClient,
  remoteBuilderSigning,
  type SecureClient,
} from "@polymarket/client";
import { signerFrom } from "@polymarket/client/viem";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { polygon } from "viem/chains";

import { BUILDER_CODE } from "@/lib/auth/public-config";

/**
 * Browser-side Polymarket client (SEC-1, SEC-2 revision).
 *
 * Orders are signed **in the browser by the user's own wallet**. This is the
 * deliberate alternative to server-side signing: signing on the server would
 * require the user to delegate their embedded wallet to us via Privy, which
 * grants standing authority to sign without per-action approval. Keeping the
 * signature in the browser means the user authorises every order and we never
 * hold that power.
 *
 * The cost is that SEC-2 ("orders are rebuilt server-side, never accepted from
 * the client") no longer applies to order construction — the browser builds and
 * signs. What protects attribution is that `builderCode` is part of the *signed*
 * order struct: a tampered order is simply an order attributed elsewhere, not a
 * way to spend someone else's funds. Nothing here can move funds the user's own
 * signer did not authorise.
 *
 * Builder authorization is fetched from `/api/builder/sign` per request, so the
 * builder secret stays on the server.
 */

/** Never `undefined` in practice — the panel guards on `isTradingConfigured`. */
export type BrowserClient = SecureClient;

/**
 * Builds an authenticated client from a Privy embedded wallet.
 *
 * @param provider EIP-1193 provider from Privy's `wallet.getEthereumProvider()`.
 *
 * Note this is expensive and interactive: `createSecureClient` performs L1 auth
 * (an EIP-712 signature) and, when the user has no Deposit Wallet yet, deploys
 * one through the Relayer. **Deployment spends one of 100 daily relay
 * transactions**, so callers must not construct this on render — only in
 * response to an explicit user action.
 */
export async function createBrowserClient(
  provider: EIP1193Provider,
  address: string,
): Promise<BrowserClient> {
  const walletClient = createWalletClient({
    // Required by the SDK, not merely by viem: `signerFrom` asserts
    // `invariant(client.account !== undefined, "Wallet client with account is
    // required")`. viem happily creates an account-less client for read paths,
    // so omitting this fails only at signing time.
    account: address as `0x${string}`,
    chain: polygon,
    transport: custom(provider),
  });

  return createSecureClient({
    signer: signerFrom(walletClient),
    // Root-relative: same origin, so the session cookie authenticates us and
    // the builder secret is never shipped to the browser.
    apiKey: remoteBuilderSigning({
      url: "/api/builder/sign",
      credentials: "same-origin",
    }),
  });
}

/** pUSD balance in base units (6 decimals). Shared by the deposit panel and the trade ticket. */
export async function readCollateralBalance(client: BrowserClient): Promise<bigint> {
  const { fetchBalanceAllowance } = await import("@polymarket/client/actions");
  const { AssetType } = await import("@polymarket/bindings/clob");
  const result = await fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
  return BigInt(result.balance ?? 0n);
}

/**
 * Heuristic check for whether trading approvals are already granted (FR-3.1
 * prerequisite — an order cannot fill without them). `allowances` is a map of
 * spender address to approved amount; presence of *any* positive entry is
 * treated as "already approved" to avoid re-spending relay quota on every
 * trade attempt. Imperfect — the exchange may require more than one spender
 * approved and this doesn't enumerate them — so `enableTradingApprovals` is
 * always re-offered as a manual fallback if an order fails on allowance.
 */
export async function hasTradingApprovals(client: BrowserClient): Promise<boolean> {
  const { fetchBalanceAllowance } = await import("@polymarket/client/actions");
  const { AssetType } = await import("@polymarket/bindings/clob");
  const result = await fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
  return Object.values(result.allowances ?? {}).some((value) => BigInt(value) > 0n);
}

/**
 * Grants the ERC-20 (pUSD) + ERC-1155 (outcome token) approvals trading
 * needs, gasless via the Relayer. Explicitly user-initiated only (same rule
 * as `createBrowserClient`) — never call this on render.
 */
export async function enableTradingApprovals(client: BrowserClient): Promise<void> {
  await client.setupTradingApprovals();
}

/**
 * The builder code for attribution.
 *
 * Public by design — it is emitted in every on-chain `OrderFilled` event, so
 * shipping it to the browser discloses nothing. Contrast the API key, secret
 * and passphrase, which never leave the server.
 */
export function builderCode(): `0x${string}` {
  return BUILDER_CODE as `0x${string}`;
}

export type MarketBuyParams = {
  tokenId: string;
  /** USD notional to buy, before fees. */
  amount: string;
  /** All-in spend cap including platform and builder taker fees. */
  maxSpend?: string;
  /** Highest acceptable price per share, 0 < p < 1. */
  maxPrice?: string;
};

export type MarketSellParams = {
  tokenId: string;
  /** Outcome tokens to sell. `1` is one whole share, not one base unit. */
  shares: string;
  minPrice?: string;
};

/**
 * Places a market buy, signed by the user's own wallet.
 *
 * `builderCode` goes **inside the signed order struct** — it is what makes the
 * fill attributable and what causes fees to accrue. An order without it is a
 * fill we earn nothing on. Because it is signed rather than appended, a client
 * cannot strip it from someone else's order; the worst a user can do is
 * attribute *their own* order elsewhere, which costs us that one fee and
 * nothing more.
 *
 * Call `preflightOrder` first — it is what enforces the geo gate and surfaces
 * the fee before the user commits.
 */
export async function placeMarketBuy(
  client: BrowserClient,
  params: MarketBuyParams,
) {
  const { OrderSide } = await import("@polymarket/client");
  return client.placeMarketOrder({
    tokenId: params.tokenId,
    side: OrderSide.BUY,
    amount: params.amount,
    builderCode: builderCode(),
    ...(params.maxSpend ? { maxSpend: params.maxSpend } : {}),
    ...(params.maxPrice ? { maxPrice: params.maxPrice } : {}),
  });
}

export async function placeMarketSell(
  client: BrowserClient,
  params: MarketSellParams,
) {
  const { OrderSide } = await import("@polymarket/client");
  return client.placeMarketOrder({
    tokenId: params.tokenId,
    side: OrderSide.SELL,
    shares: params.shares,
    builderCode: builderCode(),
    ...(params.minPrice ? { minPrice: params.minPrice } : {}),
  });
}

export type PreflightResult =
  | { allowed: true; feeBps: { taker: number; maker: number } }
  | { allowed: false; reason: string; message: string };

/**
 * Server-side pre-trade check (FR-3.5, FR-6).
 *
 * Signing moved to the browser, but validation, the geo gate and fee disclosure
 * did not — those stay on the server where they can be reasoned about and
 * logged. This is advisory in the strict sense (a determined user can sign and
 * submit to Polymarket directly, bypassing us), which is exactly why the geo
 * gate was never our only control: **Polymarket enforces jurisdiction
 * server-side regardless.** Ours exists so users get real feedback rather than
 * an opaque upstream rejection.
 */
export async function preflightOrder(body: {
  tokenId: string;
  side: "BUY" | "SELL";
  amount: string;
  maxSpend?: string;
  limitPrice?: string;
}): Promise<PreflightResult> {
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as PreflightResponse;

  if (!response.ok) {
    return {
      allowed: false,
      reason: data.error ?? "preflight_failed",
      message: data.message ?? "Order rejected before signing.",
    };
  }
  return { allowed: true, feeBps: data.feeBps };
}

/**
 * The `/api/orders` wire shape — both arms, since the error fields are what the
 * failure path reads. Declared rather than inferred: `response.json()` is typed
 * `Promise<unknown>` under the workerd runtime types (`cloudflare-env.d.ts`),
 * which is stricter, and more honest, than the DOM lib's `any`.
 */
type PreflightResponse = {
  ok?: boolean;
  feeBps: { taker: number; maker: number };
  side?: "BUY" | "SELL";
  error?: string;
  message?: string;
  tier?: string;
};
