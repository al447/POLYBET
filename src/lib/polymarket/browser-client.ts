import {
  createSecureClient,
  remoteBuilderSigning,
  type SecureClient,
} from "@polymarket/client";
import { signerFrom } from "@polymarket/client/viem";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { polygon } from "viem/chains";

import { BUILDER_CODE } from "@/lib/auth/public-config";
import {
  isTimeoutError,
  readCachedCredentials,
  writeCachedCredentials,
  type ClobCredentials,
} from "./clob-credentials";

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

const DEPLOYED_KEY_PREFIX = "polymarket:wallet-deployed:";

/**
 * Caches "this EOA's Deposit Wallet is deployed," observed directly rather
 * than predicted — the SDK has no pre-auth way to check deployment without
 * already knowing the Deposit Wallet's address, and the only function that
 * used to derive it (`deriveDepositWalletAddress`) doesn't exist in the
 * current `@polymarket/client` (it was part of the removed
 * `@polymarket/builder-relayer-client`). So instead of predicting, we
 * remember: the moment `createBrowserClient` succeeds we know for a fact the
 * wallet exists, and cache that so a later mount (reload, or a different
 * market's page) can auto-reconnect without re-risking a deploy on render.
 *
 * `localStorage`, not `sessionStorage` — deployment is permanent and
 * on-chain, so this never needs to expire. Wrapped in try/catch because
 * private-browsing/storage-disabled environments must fail closed to "no
 * cache" (falls back to the manual connect button), never throw.
 */
export function hasDeployedWalletCached(eoaAddress: string): boolean {
  try {
    return window.localStorage.getItem(DEPLOYED_KEY_PREFIX + eoaAddress.toLowerCase()) === "true";
  } catch {
    return false;
  }
}

export function markWalletDeployedCached(eoaAddress: string): void {
  try {
    window.localStorage.setItem(DEPLOYED_KEY_PREFIX + eoaAddress.toLowerCase(), "true");
  } catch {
    // Best effort — a failed write just means the next visit shows the manual button again.
  }
}

/**
 * Connects to a wallet that is already being connected, so two callers share
 * one login instead of racing.
 *
 * 🚩 Two things make this necessary rather than tidy. React StrictMode (on by
 * default for the App Router in dev) invokes effects twice, and the auto-connect
 * guards in `useBrowserClient` / `DepositWalletPanel` read a **stale closure**
 * of their own status — so the second invocation sees `"idle"` and connects
 * again. Separately, `useBrowserClient` is a plain hook, so every component
 * calling it builds its own client (`/copy-trade` has two, `/market/[slug]` has
 * two). Either way the result is concurrent, identical `POST /auth/api-key`
 * calls for the same address at nonce 0 — a write endpoint asked to create the
 * same record twice at once, which is exactly the shape that stalls past the
 * 10s ceiling described in `clob-credentials.ts`.
 *
 * Sharing the promise also hands both callers the *same* `SecureClient`, which
 * is what `useCopyEngine` already claims ("there is exactly one signer on this
 * page"). Safe because nothing calls `closeSubscriptions()` or
 * `endAuthentication()` — the only methods where one holder could break another.
 */
const connectionsInFlight = new Map<string, Promise<BrowserClient>>();

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
 *
 * Not `async` on purpose: the in-flight map has to be read and written
 * synchronously, or StrictMode's second call arrives before the first has
 * registered itself and both connect anyway.
 */
export function createBrowserClient(
  provider: EIP1193Provider,
  address: string,
): Promise<BrowserClient> {
  const key = address.toLowerCase();
  const existing = connectionsInFlight.get(key);
  if (existing) return existing;

  const pending = connectWithRetry(provider, address).finally(() => {
    connectionsInFlight.delete(key);
  });
  connectionsInFlight.set(key, pending);
  return pending;
}

/**
 * One retry, and only for a timeout.
 *
 * The 10s ceiling is enforced **client-side** by ky, so a timed-out
 * `POST /auth/api-key` very likely still reached Polymarket and created the
 * credential. That makes the second attempt cheap rather than a repeat of the
 * first: the SDK's own fallback is `POST /auth/api-key` → 400 (already exists)
 * → `GET /auth/derive-api-key`, and ky retries GETs on its own.
 *
 * Exactly one retry. Each attempt can re-prompt the user's wallet to sign, so a
 * loop would be worse than the error it is trying to paper over.
 */
async function connectWithRetry(
  provider: EIP1193Provider,
  address: string,
): Promise<BrowserClient> {
  try {
    return await connectOnce(provider, address);
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    return connectOnce(provider, address);
  }
}

async function connectOnce(
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

  // Reusing credentials skips both the EIP-712 signature and
  // `POST /auth/api-key` — see `clob-credentials.ts` for why that POST is the
  // fragile one. Stale or revoked credentials are not a problem to guard
  // against here: the SDK validates them with `GET /auth/api-keys` and, on a
  // 401, falls back to a fresh signature by itself.
  const cached = readCachedCredentials(address);
  const reuse = cached ? { credentials: await brandCredentials(cached) } : {};

  const client = await createSecureClient({
    signer: signerFrom(walletClient),
    // Root-relative: same origin, so the session cookie authenticates us and
    // the builder secret is never shipped to the browser.
    apiKey: remoteBuilderSigning({
      url: "/api/builder/sign",
      credentials: "same-origin",
    }),
    ...reuse,
  });

  writeCachedCredentials(address, client.credentials);
  return client;
}

/**
 * Re-applies the SDK's `ApiKey` brand to a key that has been through JSON.
 *
 * `toApiKey` is the identity function at runtime — the brand is a phantom type.
 * It is used anyway rather than a cast, because a cast here would be indistinguishable
 * from a cast that papers over a genuinely wrong shape, and this file already
 * carries one documented instance of that trade-off (`transferCollateral`).
 */
async function brandCredentials(cached: ClobCredentials) {
  const { toApiKey } = await import("@polymarket/bindings");
  return { ...cached, key: toApiKey(cached.key) };
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

/**
 * Whether this market will take an order right now — `null` when it could not
 * be read.
 *
 * 🚩 Two flags, and both are needed. `closed` separates a settled leg from a
 * live one (`active` stays `true` on settled legs, so it is useless here), and
 * `acceptingOrders` catches a market that has stopped taking orders while the
 * event is still open. A single event's legs settle individually, long before
 * the event closes — measured 17 of 22 legs settled on one open event — so
 * "the event is live" is not an answer to "can I trade this leg".
 *
 * ⚠️ Both live under `market.state`, not on the market itself. The SDK
 * restructures Gamma's flat JSON into `{state, outcomes, metrics, trading, …}`,
 * so the field names from `gamma-types.ts` do not transfer — reading
 * `market.closed` here is `undefined`, which reads as "open" and silently
 * disables the check.
 *
 * Only an explicit `false` blocks. Gamma leaves both fields optional, and a
 * missing flag is not evidence of a closed market; the CLOB rejects the order
 * upstream if we get it wrong, which is a worse message but not a worse
 * outcome. `null` on failure for the same reason — a lookup blip must not read
 * as "settled".
 */
export async function isMarketAcceptingOrders(
  client: BrowserClient,
  slug: string,
): Promise<boolean | null> {
  if (!slug) return null;
  try {
    const { fetchMarket } = await import("@polymarket/client/actions");
    const { state } = await fetchMarket(client, { slug });
    if (state.closed === true) return false;
    if (state.acceptingOrders === false) return false;
    return true;
  } catch {
    return null;
  }
}

export type LimitOrderParams = {
  tokenId: string;
  /** Per-share limit price, 0 < p < 1. */
  price: string;
  /** Order size in shares — always shares, unlike a market buy's USD amount. */
  size: string;
  /** Unix seconds. Omit for GTC; set for GTD (must be ≥3 minutes out — see `computeGtdExpiration`). */
  expiration?: number;
  /** Guarantees maker-side execution; rejected if it would cross the book immediately. */
  postOnly?: boolean;
};

/** Places a GTC/GTD limit buy, signed by the user's own wallet. See `placeMarketBuy` for the attribution/signing model — identical here. */
export async function placeLimitBuy(client: BrowserClient, params: LimitOrderParams) {
  const { OrderSide } = await import("@polymarket/client");
  return client.placeLimitOrder({
    tokenId: params.tokenId,
    side: OrderSide.BUY,
    price: params.price,
    size: params.size,
    builderCode: builderCode(),
    ...(params.expiration ? { expiration: params.expiration } : {}),
    ...(params.postOnly ? { postOnly: params.postOnly } : {}),
  });
}

export async function placeLimitSell(client: BrowserClient, params: LimitOrderParams) {
  const { OrderSide } = await import("@polymarket/client");
  return client.placeLimitOrder({
    tokenId: params.tokenId,
    side: OrderSide.SELL,
    price: params.price,
    size: params.size,
    builderCode: builderCode(),
    ...(params.expiration ? { expiration: params.expiration } : {}),
    ...(params.postOnly ? { postOnly: params.postOnly } : {}),
  });
}

/** Resting orders for one outcome — first page only. Hundreds of open orders on a single outcome isn't a real scenario worth building pagination for yet. */
export async function listOpenOrdersForToken(client: BrowserClient, tokenId: string) {
  const { items } = await client.listOpenOrders({ tokenId }).firstPage();
  return items;
}

/** Cancels one resting order. No server round-trip — cancellation needs no pre-flight check, consistent with the client-signing architecture. */
export async function cancelOpenOrder(client: BrowserClient, orderId: string): Promise<void> {
  await client.cancelOrder({ orderId });
}

/**
 * Moves pUSD out of the Deposit Wallet (FR-4.6). Gasless via the Relayer.
 *
 * ⚠️ **Irreversible.** Callers must validate the amount and destination
 * *before* calling this — see `validateWithdrawal` in `withdraw.ts`, and note
 * that the withdrawal flow sends to a one-off bridge address from
 * `createWithdrawAddress`, not to the user's own address directly.
 *
 * The token is our own verified `POLYGON_TOKENS.pUSD` constant rather than
 * the SDK's `client.environment.contracts.collateralToken`: the SDK's own
 * JSDoc example uses that path, but its published `EnvironmentConfig` type is
 * only `{ name, chainId }`, so `contracts` isn't on the typed surface and
 * reading it would need an unchecked cast on the one call that moves money.
 */
export async function transferCollateral(
  client: BrowserClient,
  params: { to: string; amountBaseUnit: bigint },
): Promise<string> {
  const { POLYGON_TOKENS } = await import("./config");
  const handle = await client.transferErc20({
    amount: params.amountBaseUnit,
    recipientAddress: params.to,
    tokenAddress: POLYGON_TOKENS.pUSD,
  });
  const outcome = await handle.wait();
  return outcome.transactionHash;
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
