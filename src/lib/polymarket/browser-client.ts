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
