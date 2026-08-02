import "server-only";

import type { Signer } from "@polymarket/client";

import { AuthNotConfiguredError, type AuthProvider, type AuthenticatedUser, type SessionTokens } from "./types";
import type { ServerEnv } from "@/lib/env";

/**
 * Privy auth provider (FR-1.1).
 *
 * Polymarket ships a first-party Privy signer at `@polymarket/client/privy`,
 * which is the main reason Privy was chosen over Turnkey/Magic — the embedded
 * wallet plugs straight into order signing with no bridging code.
 *
 * Privy issues two tokens:
 *   access token   proves the session is valid  (`privy-token` cookie)
 *   identity token carries the user's linked accounts (`privy-id-token` cookie)
 * We verify the access token for authentication and read the identity token to
 * find the embedded wallet without a second API round trip.
 *
 * Everything here is server-side. The app *secret* is a secret; the app id is
 * public and is the only piece the browser sees.
 */
export function createPrivyProvider(env: ServerEnv): AuthProvider {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;

  if (!appId || !appSecret) throw new AuthNotConfiguredError("Privy");

  // Imported lazily so an SDK change cannot break unrelated routes at load time.
  const clientPromise = (async () => {
    const { PrivyClient } = await import("@privy-io/node");
    return new PrivyClient({ appId, appSecret });
  })();

  return {
    name: "privy",

    async verifySession(tokens: SessionTokens): Promise<AuthenticatedUser | null> {
      if (!tokens.accessToken) return null;
      try {
        const privy = await clientPromise;
        const auth = privy.utils().auth();

        // Authenticate first. An invalid token throws.
        const claims = await auth.verifyAccessToken(tokens.accessToken);
        const userId = readUserId(claims);
        if (!userId) return null;

        // The embedded wallet lives on the identity token's linked accounts.
        if (!tokens.identityToken) return null;
        const user = await auth.verifyIdentityToken(tokens.identityToken);

        const wallet = findEmbeddedWallet(user);
        if (!wallet) return null;

        return {
          userId,
          email: findEmail(user),
          signerAddress: wallet.address,
          walletId: wallet.id,
        };
      } catch {
        // Invalid or expired tokens are an expected condition, not an error.
        return null;
      }
    },

    async createSigner(user: AuthenticatedUser): Promise<Signer> {
      const privy = await clientPromise;
      const { signerFrom } = await import("@polymarket/client/privy");
      return signerFrom({
        privy: privy as never,
        walletId: user.walletId,
      });
    },
  };
}

function readUserId(claims: unknown): string | null {
  const c = claims as { userId?: string; user_id?: string; sub?: string };
  return c.userId ?? c.user_id ?? c.sub ?? null;
}

type PrivyLinkedAccount = {
  type?: string;
  chain_type?: string;
  chainType?: string;
  address?: string;
  id?: string;
  wallet_client_type?: string;
  walletClientType?: string;
  email?: string;
  address_type?: string;
};

function linkedAccounts(user: unknown): PrivyLinkedAccount[] {
  const u = user as {
    linked_accounts?: PrivyLinkedAccount[];
    linkedAccounts?: PrivyLinkedAccount[];
  };
  return u.linked_accounts ?? u.linkedAccounts ?? [];
}

function findEmbeddedWallet(user: unknown): { address: string; id: string } | null {
  for (const account of linkedAccounts(user)) {
    const isWallet = account.type === "wallet";
    const isEthereum = (account.chain_type ?? account.chainType) === "ethereum";
    const isEmbedded = (account.wallet_client_type ?? account.walletClientType) === "privy";
    if (isWallet && isEthereum && isEmbedded && account.address && account.id) {
      return { address: account.address, id: account.id };
    }
  }
  return null;
}

function findEmail(user: unknown): string | undefined {
  return linkedAccounts(user).find((a) => a.type === "email")?.email;
}
