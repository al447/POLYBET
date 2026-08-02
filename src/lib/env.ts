import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Server-only secrets. These come from Cloudflare secrets in production and
 * `.dev.vars` locally — never from build-time `process.env`, which Next would
 * inline into the bundle.
 *
 * `serverRuntimeConfig` was removed in Next 16; this is the replacement.
 */
export type ServerEnv = {
  /** P-1 builder code (bytes32 hex) — attached to every signed order. */
  POLYMARKET_BUILDER_CODE?: string;
  /** P-2..P-4 builder API credentials. */
  POLYMARKET_BUILDER_API_KEY?: string;
  POLYMARKET_BUILDER_SECRET?: string;
  POLYMARKET_BUILDER_PASSPHRASE?: string;
  /** OI-6 fee rates in basis points. Taker <= 100, maker <= 50. */
  BUILDER_FEE_BPS_TAKER?: string;
  BUILDER_FEE_BPS_MAKER?: string;
  /** P-6 Privy server credentials. */
  PRIVY_APP_SECRET?: string;
  /** P-9 Polygon RPC. */
  POLYGON_RPC_URL?: string;
};

const SECRET_KEYS = [
  "POLYMARKET_BUILDER_CODE",
  "POLYMARKET_BUILDER_API_KEY",
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
  "PRIVY_APP_SECRET",
] as const satisfies readonly (keyof ServerEnv)[];

/**
 * Reads the Cloudflare environment at request time.
 *
 * Falls back to `process.env` only outside the Workers runtime (vitest, scripts).
 */
export async function serverEnv(): Promise<ServerEnv> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return env as unknown as ServerEnv;
  } catch {
    return process.env as unknown as ServerEnv;
  }
}

/** Throws if a required secret is missing, without ever echoing its value. */
export function requireSecret(env: ServerEnv, key: keyof ServerEnv): string {
  const value = env[key];
  if (!value) {
    throw new Error(
      `Missing required secret ${key}. Set it with: wrangler secret put ${key}`,
    );
  }
  return value;
}

/**
 * Reports which secrets are present. Returns booleans only — the values must
 * never reach a response body or a log line (SEC-4).
 */
export function secretPresence(env: ServerEnv): Record<string, boolean> {
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, Boolean(env[k])]));
}

/**
 * True when real Polymarket builder credentials are configured. Until the
 * client supplies P-1..P-4 the app runs in mock mode: everything renders and
 * every code path is exercised, but no order is signed or submitted.
 */
export function hasBuilderCredentials(env: ServerEnv): boolean {
  return Boolean(
    env.POLYMARKET_BUILDER_CODE &&
      env.POLYMARKET_BUILDER_API_KEY &&
      env.POLYMARKET_BUILDER_SECRET &&
      env.POLYMARKET_BUILDER_PASSPHRASE,
  );
}
