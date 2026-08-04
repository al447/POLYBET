import "server-only";

import {
  createSecureClient,
  type SecureClient,
  type Signer,
} from "@polymarket/client";
// Standalone actions live on the /actions subpath rather than the root export.
import { deployDepositWallet, isWalletDeployed } from "@polymarket/client/actions";

// `builderApiKey` lives on the /node subpath but pulls in no node: builtins,
// so it runs on workerd unchanged.
import { builderApiKey } from "@polymarket/client/node";

import { resolveBuilderAuth, resolveBuilderConfig, type BuilderConfig } from "./builder";
import { COLLATERAL } from "./config";
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
    // Required, not optional. Omitting `wallet` (which is what we want — the
    // user's deterministic Deposit Wallet becomes the account) makes the SDK
    // deploy that wallet during setup, and deployment goes through the Relayer.
    // With no authorization the client throws `InvariantError: Deposit Wallet
    // deployment requires a Relayer API Key or Builder API Key in the client
    // configuration`, which surfaces to the UI as `wallet_status_failed`.
    apiKey: builderApiKey(resolveBuilderAuth(params.env)),
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

/**
 * Reads the Deposit Wallet state without deploying it (FR-1.2, FR-1.4).
 *
 * Strictly read-only, unlike `ensureDepositWallet`. The wallet panel polls this
 * while a user waits for a deposit to land, and a poll that could deploy would
 * drain the 100/day relay budget in minutes.
 */
export async function readWalletStatus(ctx: ClientContext): Promise<{
  address: string;
  deployed: boolean;
  balance: CollateralBalance | null;
}> {
  const address = await resolveAccountAddress(ctx.client);
  const deployed = await isWalletDeployed(ctx.client);

  // An undeployed wallet has no CLOB-side balance to read; asking for one is a
  // guaranteed error rather than a zero.
  const balance = deployed ? await fetchCollateralBalance(ctx) : null;

  return { address, deployed, balance };
}

export type CollateralBalance = {
  /** Base units — pUSD has 6 decimals. */
  raw: string;
  /** Human-readable, e.g. "12.50". */
  formatted: string;
  symbol: string;
};

/**
 * The user's pUSD collateral balance.
 *
 * Collateral is pUSD, not USDC: deposits arrive as USDC and auto-convert on
 * arrival. Every balance, fee and PnL figure in the app is pUSD.
 */
export async function fetchCollateralBalance(
  ctx: ClientContext,
): Promise<CollateralBalance> {
  // Another one on the /actions subpath: unlike `placeMarketOrder`, balance is
  // NOT a client instance method. Check `dist/actions/index.d.ts` before
  // assuming which side of that split a call falls on.
  const { fetchBalanceAllowance } = await import("@polymarket/client/actions");
  const { AssetType } = await import("@polymarket/bindings/clob");

  const result = await fetchBalanceAllowance(ctx.client, {
    assetType: AssetType.COLLATERAL,
  });

  const raw = BigInt(result.balance ?? 0n);
  return {
    raw: raw.toString(),
    formatted: formatUnits(raw, COLLATERAL.decimals),
    symbol: COLLATERAL.symbol,
  };
}

/** Base units to a fixed-2 decimal string. Avoids float entirely. */
function formatUnits(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  const padded = fraction.toString().padStart(decimals, "0").slice(0, 2);
  return `${whole}.${padded}`;
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
