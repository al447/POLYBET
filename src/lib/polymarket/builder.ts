import "server-only";

import { FEE_CAPS_BPS } from "./config";
import { resolveFeeBps } from "./fees";
import type { ServerEnv } from "@/lib/env";

/**
 * Builder attribution (SEC-1, SEC-2, FR-3.5).
 *
 * Attribution is a `bytes32` builder code carried *inside the signed order
 * struct* — it surfaces in the on-chain `OrderFilled` event and is what causes
 * fees to accrue to the client's builder profile. It is not a request header or
 * a wrapper, so it cannot be bolted on after signing.
 *
 * The code itself is not secret (it appears on-chain), but the API
 * key/secret/passphrase are, and they must never leave the server.
 */

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type BuilderConfig = {
  builderCode: `0x${string}`;
  feeBps: { taker: number; maker: number };
};

export class MissingBuilderCredentialsError extends Error {
  constructor() {
    super(
      "Polymarket builder credentials are not configured (P-1..P-4). " +
        "Set them with `wrangler secret put`; see implementation.md section 1.",
    );
    this.name = "MissingBuilderCredentialsError";
  }
}

/**
 * Resolves builder config from the request-time environment.
 *
 * @throws {MissingBuilderCredentialsError} when the builder code is absent.
 */
export function resolveBuilderConfig(env: ServerEnv): BuilderConfig {
  const code = env.POLYMARKET_BUILDER_CODE;
  if (!code) throw new MissingBuilderCredentialsError();

  if (!BYTES32_PATTERN.test(code)) {
    throw new Error(
      "POLYMARKET_BUILDER_CODE must be a 32-byte hex string (0x + 64 hex chars). " +
        "Copy it from polymarket.com -> Settings -> Builders.",
    );
  }

  return {
    builderCode: code as `0x${string}`,
    feeBps: resolveFeeBps(env),
  };
}

/** L2 builder credentials (P-2…P-4). Distinct from the builder code (P-1). */
export type BuilderAuth = {
  key: string;
  secret: string;
  passphrase: string;
};

/**
 * Builder API credentials for SDK request authorization.
 *
 * Separate from `resolveBuilderConfig` because these answer different
 * questions: the builder *code* is attribution and rides inside the signed
 * order, while these credentials authenticate our infrastructure requests to
 * the Relayer and CLOB.
 *
 * Required for anything that touches the Relayer — Deposit Wallet deployment
 * in particular. Without them `createSecureClient` fails with
 * `InvariantError: Deposit Wallet deployment requires a Relayer API Key or
 * Builder API Key in the client configuration`.
 *
 * @throws {MissingBuilderCredentialsError} when any of the three is absent.
 */
export function resolveBuilderAuth(env: ServerEnv): BuilderAuth {
  const key = env.POLYMARKET_BUILDER_API_KEY;
  const secret = env.POLYMARKET_BUILDER_SECRET;
  const passphrase = env.POLYMARKET_BUILDER_PASSPHRASE;

  if (!key || !secret || !passphrase) throw new MissingBuilderCredentialsError();

  return { key, secret, passphrase };
}

/**
 * Validates configured fee rates without throwing, for health/diagnostics.
 */
export function describeBuilderConfig(env: ServerEnv): {
  configured: boolean;
  codeValid: boolean;
  feeBps: { taker: number; maker: number } | null;
  caps: typeof FEE_CAPS_BPS;
  problems: string[];
} {
  const problems: string[] = [];
  const code = env.POLYMARKET_BUILDER_CODE;
  const codeValid = Boolean(code && BYTES32_PATTERN.test(code));

  if (!code) problems.push("POLYMARKET_BUILDER_CODE is not set (P-1)");
  else if (!codeValid) problems.push("POLYMARKET_BUILDER_CODE is not a 32-byte hex string");

  if (!env.POLYMARKET_BUILDER_API_KEY) problems.push("POLYMARKET_BUILDER_API_KEY is not set (P-2)");
  if (!env.POLYMARKET_BUILDER_SECRET) problems.push("POLYMARKET_BUILDER_SECRET is not set (P-3)");
  if (!env.POLYMARKET_BUILDER_PASSPHRASE) problems.push("POLYMARKET_BUILDER_PASSPHRASE is not set (P-4)");

  let feeBps: { taker: number; maker: number } | null = null;
  try {
    feeBps = resolveFeeBps(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  return {
    configured: problems.length === 0,
    codeValid,
    feeBps,
    caps: FEE_CAPS_BPS,
    problems,
  };
}
