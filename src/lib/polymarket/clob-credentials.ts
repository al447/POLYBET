/**
 * CLOB L2 credential cache, and the error vocabulary around building a client.
 *
 * Deliberately free of `@polymarket/client` imports so it stays unit-testable
 * under vitest's node environment — same split as `gamma-types.ts` and
 * `price-history-types.ts`. `browser-client.ts` is the only caller and does the
 * (structurally identical) hand-off to the SDK's `ApiKeyCreds`.
 *
 * ## Why cache at all
 *
 * `createSecureClient` without `credentials` runs the full first-time login on
 * every construction: an EIP-712 signature, then `POST /auth/api-key`. That POST
 * is the single most fragile call in the app — the SDK builds its HTTP client as
 * `ky.create({prefixUrl, throwHttpErrors: false})`, so it inherits ky's default
 * **10 second timeout**, and ky never retries a POST (`retryMethods` is
 * get/put/head/delete/options/trace, `retryOnTimeout: false`). There is no
 * timeout option on `SecureClientOptions` to raise it. One slow response and the
 * user is stuck on `Request timed out: POST https://clob.polymarket.com/auth/api-key`.
 *
 * Handing `credentials` back to `createSecureClient` skips both the signature and
 * that POST — the SDK validates them with `GET /auth/api-keys` instead, which ky
 * *does* retry. So this turns a per-page-load risk into a once-per-wallet one.
 *
 * ## Why `sessionStorage`
 *
 * These are secrets; the `polymarket:wallet-deployed:` flag next door is not
 * (it records a permanent on-chain fact, so it lives in `localStorage`). Scoped
 * to the tab session, they survive a reload — which is the case that matters —
 * and are gone when the tab closes.
 *
 * What a stolen credential can and cannot do, so the trade-off is explicit:
 * it **cannot place an order** (an order carries the user's own EIP-712
 * signature over the order struct; these only sign the HTTP request), but it
 * **can** read that user's private CLOB data and cancel their resting orders.
 */

/**
 * Structurally `ApiKeyCreds` from `@polymarket/bindings/clob`, minus the branded
 * `ApiKey` string — the brand is re-applied at the SDK boundary with `toApiKey`.
 */
export type ClobCredentials = {
  key: string;
  secret: string;
  passphrase: string;
};

const CREDS_KEY_PREFIX = "polymarket:clob-creds:";

function storageKey(eoaAddress: string): string {
  return CREDS_KEY_PREFIX + eoaAddress.toLowerCase();
}

/**
 * Validates one stored credential blob.
 *
 * Everything read back out of storage is untrusted input — same discipline as
 * `copy-trade/store.ts`. A partial object is the dangerous shape here: two of
 * three fields would be handed to the SDK, fail L2 signing in a way that looks
 * like a revoked key, and send the user round the fallback path for no reason.
 * All three or nothing.
 */
export function sanitiseCredentials(value: unknown): ClobCredentials | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, secret, passphrase } = value as Record<string, unknown>;
  if (typeof key !== "string" || key === "") return null;
  if (typeof secret !== "string" || secret === "") return null;
  if (typeof passphrase !== "string" || passphrase === "") return null;
  return { key, secret, passphrase };
}

/**
 * Cached credentials for this signer, or `null` for "authenticate from scratch".
 *
 * Every failure mode — storage disabled, malformed JSON, a half-written blob —
 * collapses to `null`, which costs one signature and is always correct. Never
 * throws: a private-browsing window must still be able to log in.
 */
export function readCachedCredentials(eoaAddress: string): ClobCredentials | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(eoaAddress));
    if (!raw) return null;
    return sanitiseCredentials(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeCachedCredentials(eoaAddress: string, credentials: ClobCredentials): void {
  try {
    // Re-sanitised on the way in as well, so a malformed write can never make
    // it to disk and the read path never has to reason about our own bugs.
    const clean = sanitiseCredentials(credentials);
    if (!clean) return;
    window.sessionStorage.setItem(storageKey(eoaAddress), JSON.stringify(clean));
  } catch {
    // Best effort — a failed write just means the next connect signs again.
  }
}

export function clearCachedCredentials(eoaAddress: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(eoaAddress));
  } catch {
    // Nothing to do; the entry either never existed or is unreachable anyway.
  }
}

/**
 * Whether a thrown value is the request-timeout case.
 *
 * Matched on `name` first because both ky's `TimeoutError` and the SDK's own
 * wrapper set it, and on the message second because the SDK re-wraps some
 * errors into `PolymarketError` subclasses without preserving the name. The
 * message check is deliberately loose for that reason — a false positive costs
 * one extra attempt, a false negative costs the user their setup.
 */
export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  return /timed out/i.test(error.message);
}

/**
 * A sentence a user can act on, instead of a library internal.
 *
 * `Request timed out: POST https://clob.polymarket.com/auth/api-key` is ky's
 * own string and names a URL the user has no relationship with. The timeout
 * copy points at retrying specifically because retrying usually works: the
 * timeout is client-side, so the credential was probably created anyway, and
 * the next attempt takes the SDK's cheap `POST → 400 → GET /auth/derive-api-key`
 * path.
 */
export function describeConnectError(error: unknown): string {
  if (isTimeoutError(error)) {
    return "Polymarket did not answer in time. Your setup may already be half-finished — try again, which usually completes it.";
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "wallet_setup_failed";
}
