import { COLLATERAL, FEE_CAPS_BPS } from "./config";

/**
 * Builder fee math.
 *
 * Two rules from the Polymarket docs (verified 2026-08-02) drive everything here:
 *   1. Builder fees are `notional * bps / 10_000`, paid by the *user*.
 *   2. They STACK on top of Polymarket's own platform fees — they don't replace
 *      them. So a balance check against notional alone will let orders through
 *      that then fail at submit.
 *
 * All arithmetic is integer arithmetic on 6-decimal base units. Doing this in
 * floats produces off-by-a-hair errors that surface as rejected orders at the
 * exact moment a user is spending money.
 */

const SCALE = 10n ** BigInt(COLLATERAL.decimals);
const BPS_DIVISOR = 10_000n;

export type FeeBreakdown = {
  /** Order notional in base units. */
  notional: bigint;
  /** Our builder fee in base units. */
  builderFee: bigint;
  /** Polymarket's own fee, when known. */
  platformFee: bigint;
  /** notional + platformFee + builderFee. */
  totalRequired: bigint;
  builderFeeBps: number;
};

/** Parses a human decimal string ("12.34") into 6-decimal base units. */
export function toBaseUnits(amount: string | number): bigint {
  const text = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const [whole, fraction = ""] = text.split(".");
  const padded = fraction.padEnd(COLLATERAL.decimals, "0").slice(0, COLLATERAL.decimals);
  return BigInt(whole || "0") * SCALE + BigInt(padded || "0");
}

/** Formats base units back to a human decimal string. */
export function fromBaseUnits(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(COLLATERAL.decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  const text = trimmed ? `${whole}.${trimmed}` : whole.toString();
  return negative ? `-${text}` : text;
}

/**
 * Fee for a notional in base units.
 *
 * Rounds up. The platform collects a whole base unit, so rounding down would
 * leave orders a sub-cent short of their own fee and fail at submit.
 */
export function calculateFee(notional: bigint, bps: number): bigint {
  assertValidBps(bps);
  if (notional <= 0n) return 0n;
  const numerator = notional * BigInt(bps);
  const quotient = numerator / BPS_DIVISOR;
  return numerator % BPS_DIVISOR === 0n ? quotient : quotient + 1n;
}

export function calculateFeeBreakdown(params: {
  notional: bigint;
  builderFeeBps: number;
  platformFee?: bigint;
}): FeeBreakdown {
  const platformFee = params.platformFee ?? 0n;
  const builderFee = calculateFee(params.notional, params.builderFeeBps);
  return {
    notional: params.notional,
    builderFee,
    platformFee,
    totalRequired: params.notional + platformFee + builderFee,
    builderFeeBps: params.builderFeeBps,
  };
}

export type BalanceCheck =
  | { ok: true; breakdown: FeeBreakdown }
  | { ok: false; breakdown: FeeBreakdown; shortfall: bigint; reason: string };

/**
 * Pre-trade balance check covering notional + platform fees + builder fees.
 * This is FR-3.6 / correction C-5 — the check the original SRS omitted.
 */
export function checkBalance(params: {
  balance: bigint;
  notional: bigint;
  builderFeeBps: number;
  platformFee?: bigint;
}): BalanceCheck {
  const breakdown = calculateFeeBreakdown(params);
  if (params.balance >= breakdown.totalRequired) return { ok: true, breakdown };

  const shortfall = breakdown.totalRequired - params.balance;
  return {
    ok: false,
    breakdown,
    shortfall,
    reason:
      `Insufficient ${COLLATERAL.symbol}. Need ${fromBaseUnits(breakdown.totalRequired)} ` +
      `(${fromBaseUnits(breakdown.notional)} order + ${fromBaseUnits(breakdown.platformFee + breakdown.builderFee)} fees), ` +
      `short by ${fromBaseUnits(shortfall)}.`,
  };
}

/** Validates a configured fee rate against Polymarket's caps. */
export function assertValidBps(bps: number, side: "taker" | "maker" = "taker"): void {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(`Fee bps must be a non-negative integer, got ${bps}`);
  }
  const cap = FEE_CAPS_BPS[side];
  if (bps > cap) {
    throw new Error(
      `${side} fee ${bps} bps exceeds the Polymarket cap of ${cap} bps`,
    );
  }
}

/** Reads and validates configured fee rates, defaulting to 0 (no fee). */
export function resolveFeeBps(env: {
  BUILDER_FEE_BPS_TAKER?: string;
  BUILDER_FEE_BPS_MAKER?: string;
}): { taker: number; maker: number } {
  const taker = Number(env.BUILDER_FEE_BPS_TAKER ?? 0);
  const maker = Number(env.BUILDER_FEE_BPS_MAKER ?? 0);
  assertValidBps(taker, "taker");
  assertValidBps(maker, "maker");
  return { taker, maker };
}
