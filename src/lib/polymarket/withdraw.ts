import { isAddress } from "viem";

import {
  BRIDGE_ENDPOINT,
  CHAIN_ID,
  MIN_WITHDRAWAL_USD,
  POLYGON_TOKENS,
} from "./config";
import { toBaseUnits } from "./fees";

/**
 * Withdrawals via Polymarket's Bridge API (FR-4.6, implementation.md Step 4.4).
 *
 * The SDK does not wrap this API, so these are hand-rolled fetches. The full
 * flow, verified live 2026-08-09:
 *
 *   1. `GET  /supported-assets`  cross-check our token constants + minimum
 *   2. `POST /quote`             what the user will actually receive
 *   3. `POST /withdraw`          returns a one-off bridge address
 *   4. transfer pUSD → that address  (SDK `transferErc20`, gasless)
 *   5. `GET  /status/{address}`  track arrival
 *
 * Polymarket unwraps pUSD → USDC through their Collateral Offramp and a
 * Uniswap v3 pool on their side; we never touch those contracts. They charge
 * no withdrawal fee — the quote's costs are gas plus swap impact.
 *
 * Browser-side, same reasoning as `portfolio.ts`: the flow is keyed to the
 * user's Deposit Wallet address, which the server never learns.
 *
 * ⚠️ Step 4 is irreversible. Everything here is built so that a wrong amount
 * or address is caught *before* a signature, never after.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** Bridge chain ids are strings in the wire format, unlike the SDK's numeric CHAIN_ID. */
const POLYGON_CHAIN_ID = String(CHAIN_ID);

export class BridgeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeApiError";
  }
}

/** Wire shapes declared rather than inferred — `response.json()` is `unknown` under the workerd types. */
type SupportedAsset = {
  chainId: string;
  chainName: string;
  token: { name: string; symbol: string; address: string; decimals: number };
  minCheckoutUsd: number;
};

export type WithdrawQuote = {
  quoteId: string;
  /** Destination-token base units the user is estimated to receive. */
  estToTokenBaseUnit: string;
  estOutputUsd: number;
  estInputUsd: number;
  estCheckoutTimeMs: number;
  estFeeBreakdown: { gasUsd: number; minReceived: number; totalImpactUsd: number };
};

// ---------------------------------------------------------------------------
// Pure validation — the testable core. No network, no client.
// ---------------------------------------------------------------------------

export type WithdrawalValidation =
  | { ok: true; amountBaseUnit: bigint }
  | { ok: false; reason: string };

/**
 * Gate every withdrawal through this before showing a confirm step. Ordered
 * so the user sees the most fundamental problem first rather than a
 * misleading downstream one (e.g. "enter an amount" before "below minimum").
 */
export function validateWithdrawal(params: {
  amount: string;
  recipient: string;
  balance: bigint;
  minUsd?: number;
}): WithdrawalValidation {
  const minUsd = params.minUsd ?? MIN_WITHDRAWAL_USD;

  let amountBaseUnit: bigint;
  try {
    amountBaseUnit = toBaseUnits(params.amount);
  } catch {
    return { ok: false, reason: "Enter a valid amount." };
  }
  if (amountBaseUnit <= 0n) {
    return { ok: false, reason: "Enter an amount greater than zero." };
  }

  // Raw addresses only — the bridge does not resolve ENS, and a name sent
  // as an address is funds gone.
  if (!isAddress(params.recipient)) {
    return { ok: false, reason: "Enter a valid Polygon wallet address (0x…)." };
  }

  if (amountBaseUnit < toBaseUnits(String(minUsd))) {
    return { ok: false, reason: `Minimum withdrawal is $${minUsd}.` };
  }

  if (amountBaseUnit > params.balance) {
    return { ok: false, reason: "Amount exceeds your available balance." };
  }

  return { ok: true, amountBaseUnit };
}

// ---------------------------------------------------------------------------
// Bridge API
// ---------------------------------------------------------------------------

/**
 * Re-derives the pUSD/USDC addresses and the minimum from the live asset
 * list and asserts they still match our constants.
 *
 * This exists because `POLYGON_TOKENS` is a hardcoded address that funds get
 * sent to. Hardcoding is right (it's the authoritative source at the moment
 * it was verified, and shouldn't silently follow a remote list), but a stale
 * constant here is the single most expensive bug this codebase could have —
 * so we spend one request to prove it's still true, and refuse rather than
 * proceed on a mismatch.
 */
export async function assertBridgeAssetsUnchanged(): Promise<{ minUsd: number }> {
  const { supportedAssets } = await bridgeFetch<{ supportedAssets: SupportedAsset[] }>(
    "/supported-assets",
  );

  const polygon = supportedAssets.filter((asset) => asset.chainId === POLYGON_CHAIN_ID);
  const pusd = polygon.find((asset) => asset.token.symbol === "pUSD");
  const usdc = polygon.find((asset) => asset.token.symbol === "USDC");

  if (!pusd || !usdc) {
    throw new BridgeApiError("Bridge no longer lists pUSD/USDC on Polygon.", 0);
  }
  if (!sameAddress(pusd.token.address, POLYGON_TOKENS.pUSD)) {
    throw new BridgeApiError("pUSD address changed upstream — withdrawal halted.", 0);
  }
  if (!sameAddress(usdc.token.address, POLYGON_TOKENS.USDC)) {
    throw new BridgeApiError("USDC address changed upstream — withdrawal halted.", 0);
  }

  return { minUsd: usdc.minCheckoutUsd };
}

/** What the user actually receives, before they commit. */
export async function fetchWithdrawQuote(params: {
  amountBaseUnit: bigint;
  recipientAddress: string;
}): Promise<WithdrawQuote> {
  return bridgeFetch<WithdrawQuote>("/quote", {
    method: "POST",
    body: {
      fromAmountBaseUnit: params.amountBaseUnit.toString(),
      fromChainId: POLYGON_CHAIN_ID,
      fromTokenAddress: POLYGON_TOKENS.pUSD,
      recipientAddress: params.recipientAddress,
      toChainId: POLYGON_CHAIN_ID,
      toTokenAddress: POLYGON_TOKENS.USDC,
    },
  });
}

/**
 * Reserves the one-off bridge address to send pUSD to. Returns the `evm`
 * address only — our wallet is on Polygon, and the `svm`/`btc`/`tvm`
 * addresses in the response are for other source chains. Sending Polygon
 * funds to one of those loses them.
 */
export async function createWithdrawAddress(params: {
  walletAddress: string;
  recipientAddress: string;
}): Promise<string> {
  const response = await bridgeFetch<{ address: { evm?: string } }>("/withdraw", {
    method: "POST",
    body: {
      address: params.walletAddress,
      toChainId: POLYGON_CHAIN_ID,
      toTokenAddress: POLYGON_TOKENS.USDC,
      recipientAddr: params.recipientAddress,
    },
  });

  const evm = response.address?.evm;
  if (!evm || !isAddress(evm)) {
    throw new BridgeApiError("Bridge did not return a usable Polygon address.", 0);
  }
  return evm;
}

export async function fetchWithdrawStatus(walletAddress: string): Promise<unknown> {
  return bridgeFetch<unknown>(`/status/${encodeURIComponent(walletAddress)}`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function bridgeFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BRIDGE_ENDPOINT}${path}`, {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      throw new BridgeApiError(`Bridge ${path} returned ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof BridgeApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeApiError(`Bridge ${path} failed: ${message}`, 0);
  } finally {
    clearTimeout(timeout);
  }
}
