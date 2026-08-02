import "server-only";

import {
  createSecureClient,
  type SecureClient,
  type Signer,
} from "@polymarket/client";
// Standalone actions live on the /actions subpath rather than the root export.
import { deployDepositWallet, isWalletDeployed } from "@polymarket/client/actions";

import { resolveBuilderConfig, type BuilderConfig } from "./builder";
import type { ServerEnv } from "@/lib/env";

/**
 * CLOB client (FR-1.3, FR-3.5).
 *
 * Every call in here runs server-side. Builder credentials must never reach the
 * browser (SEC-1), and orders must be rebuilt server-side rather than accepted
 * from the client (SEC-2) — a client-supplied order object is an instruction to
 * move someone's money.
 *
 * Auth is two-layer:
 *   L1  the user's wallet signs an EIP-712 `ClobAuth` message
 *   L2  each private request is signed HMAC-SHA256 with the derived credentials
 * `createSecureClient` performs the L1 exchange and handles L2 per request.
 */

export type PolymarketClient = Awaited<ReturnType<typeof createSecureClient>>;

export type ClientContext = {
  client: PolymarketClient;
  builder: BuilderConfig;
};

/**
 * Creates an authenticated client for a user.
 *
 * Omitting `wallet` makes the SDK use the signer's deterministic Deposit Wallet
 * as the account — which is what we want for embedded-wallet users.
 */
export async function createUserClient(params: {
  env: ServerEnv;
  signer: Signer;
  wallet?: string;
}): Promise<ClientContext> {
  const builder = resolveBuilderConfig(params.env);
  const client = await createSecureClient({
    signer: params.signer,
    ...(params.wallet ? { wallet: params.wallet } : {}),
  });
  return { client, builder };
}

/* -------------------------------------------------------------------------- */
/* Wallet lifecycle (FR-1.2)                                                   */
/* -------------------------------------------------------------------------- */

export type WalletProvisionResult = {
  address: string;
  alreadyDeployed: boolean;
  transactionHash?: string;
};

/**
 * Ensures the user has a deployed Deposit Wallet with trading approvals.
 *
 * Deposit Wallets (ERC-1967 beacon proxy) are the current standard and replace
 * the legacy Gnosis Safe the original SRS specified.
 *
 * Checks deployment before deploying. Under the Unverified tier we get 100
 * relay transactions per DAY across dev, QA and production, so a redundant
 * deploy is not a wasted millisecond — it is a meaningful share of the budget.
 */
export async function ensureDepositWallet(
  ctx: ClientContext,
): Promise<WalletProvisionResult> {
  const { client } = ctx;
  const address = await resolveAccountAddress(client);

  // `isWalletDeployed` and `deployDepositWallet` are standalone actions in the
  // SDK rather than client methods; the rest below are client methods.
  if (await isWalletDeployed(client)) {
    return { address, alreadyDeployed: true };
  }

  const handle = await deployDepositWallet(client);
  const outcome = await handle.wait();

  // Approvals are required before the account can trade at all.
  await client.setupTradingApprovals();

  return {
    address,
    alreadyDeployed: false,
    transactionHash:
      (outcome as { transactionHash?: string } | undefined)?.transactionHash,
  };
}

async function resolveAccountAddress(client: PolymarketClient): Promise<string> {
  const candidate = client as unknown as {
    account?: { address?: string };
    wallet?: string;
  };
  return candidate.account?.address ?? candidate.wallet ?? "";
}

/* -------------------------------------------------------------------------- */
/* Orders (FR-3.1, FR-3.2, FR-3.5)                                             */
/* -------------------------------------------------------------------------- */

export type MarketBuyParams = {
  tokenId: string;
  /** USD notional to buy, before fees. */
  amount: string;
  /**
   * All-in spend cap including platform and builder taker fees. Set equal to
   * `amount` when the user's stated figure must include fees.
   */
  maxSpend?: string;
  /** Highest acceptable price per share. */
  maxPrice?: string;
};

export type MarketSellParams = {
  tokenId: string;
  /** Outcome tokens to sell. `1` is one whole share, not one base unit. */
  shares: string;
  minPrice?: string;
};

/**
 * Places a market buy, attributed to the builder.
 *
 * `builderCode` goes into the signed order struct — it is what makes the fill
 * attributable and what causes fees to accrue. An order without it is a fill we
 * earn nothing on.
 */
export async function placeMarketBuy(
  ctx: ClientContext,
  params: MarketBuyParams,
) {
  const { OrderSide } = await import("@polymarket/client");
  return ctx.client.placeMarketOrder({
    tokenId: params.tokenId,
    side: OrderSide.BUY,
    amount: params.amount,
    builderCode: ctx.builder.builderCode,
    ...(params.maxSpend ? { maxSpend: params.maxSpend } : {}),
    ...(params.maxPrice ? { maxPrice: params.maxPrice } : {}),
  });
}

export async function placeMarketSell(
  ctx: ClientContext,
  params: MarketSellParams,
) {
  const { OrderSide } = await import("@polymarket/client");
  return ctx.client.placeMarketOrder({
    tokenId: params.tokenId,
    side: OrderSide.SELL,
    shares: params.shares,
    builderCode: ctx.builder.builderCode,
    ...(params.minPrice ? { minPrice: params.minPrice } : {}),
  });
}

/** Estimates fill price for slippage display (FR-3.7). */
export async function estimatePrice(
  ctx: ClientContext,
  params: { tokenId: string; amount: number; side: "BUY" | "SELL" },
) {
  const { OrderSide } = await import("@polymarket/client");
  return ctx.client.estimateMarketPrice({
    tokenId: params.tokenId,
    side: params.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
    amount: params.amount,
  } as Parameters<SecureClient["estimateMarketPrice"]>[0]);
}

/**
 * Whether Polymarket itself has the account in closed-only mode.
 *
 * This is upstream truth and is checked in addition to our own geo gate — the
 * account may be restricted for reasons unrelated to request IP.
 */
export async function isAccountCloseOnly(ctx: ClientContext): Promise<boolean> {
  return ctx.client.fetchClosedOnlyMode();
}

/** Confirms our own attributed fills — the Milestone 1 acceptance check. */
export async function listOwnBuilderTrades(ctx: ClientContext) {
  return ctx.client.listBuilderTrades({
    builderCode: ctx.builder.builderCode,
  });
}
