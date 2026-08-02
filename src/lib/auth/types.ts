import type { Signer } from "@polymarket/client";

/**
 * Provider-agnostic auth boundary (OI-4).
 *
 * Privy is the chosen provider, but every provider-specific import lives behind
 * this interface so a switch to Turnkey or Magic touches one file rather than
 * the whole trading path.
 */

export type AuthenticatedUser = {
  /** Stable provider-side user id. */
  userId: string;
  email?: string;
  /** Embedded EOA that signs on the user's behalf. */
  signerAddress: string;
  /** Provider-side wallet id, needed to build a Signer. */
  walletId: string;
};

/**
 * Providers generally issue an auth token plus a separate token carrying user
 * data. Privy calls these the access token and the identity token.
 */
export type SessionTokens = {
  accessToken: string;
  identityToken?: string;
};

export interface AuthProvider {
  readonly name: string;
  /** Verifies session tokens and returns the user, or null when invalid. */
  verifySession(tokens: SessionTokens): Promise<AuthenticatedUser | null>;
  /** Builds a Polymarket Signer bound to the user's embedded wallet. */
  createSigner(user: AuthenticatedUser): Promise<Signer>;
}

export class AuthNotConfiguredError extends Error {
  constructor(provider: string) {
    super(
      `${provider} is not configured. Set PRIVY_APP_SECRET and ` +
        `NEXT_PUBLIC_PRIVY_APP_ID (P-6); see implementation.md section 1.`,
    );
    this.name = "AuthNotConfiguredError";
  }
}
