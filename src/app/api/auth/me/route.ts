import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_TOKEN_COOKIE,
  IDENTITY_TOKEN_COOKIE,
  getAuthProvider,
  getCurrentUser,
} from "@/lib/auth/session";

/**
 * Server-verified session (FR-1.1).
 *
 * This is the round trip that proves auth actually works: the browser holds
 * Privy's cookies, and the server independently verifies them before trusting
 * any identity. Every signing route depends on the same path, so if this
 * returns a user, `/api/orders` and `/api/wallet/deploy` will authenticate too.
 *
 * On failure it reports *which* precondition is missing rather than a bare 401.
 * The most common misconfiguration — identity tokens not enabled in the Privy
 * dashboard — otherwise looks identical to "not logged in", and that ambiguity
 * costs an afternoon. Cookie names only; values are never echoed (SEC-4).
 */
export async function GET() {
  const provider = await getAuthProvider();
  if (!provider) {
    return NextResponse.json(
      {
        authenticated: false,
        reason: "auth_not_configured",
        hint: "Set PRIVY_APP_SECRET and NEXT_PUBLIC_PRIVY_APP_ID (P-6).",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const store = await cookies();
  const hasAccessToken = Boolean(store.get(ACCESS_TOKEN_COOKIE)?.value);
  const hasIdentityToken = Boolean(store.get(IDENTITY_TOKEN_COOKIE)?.value);

  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json(
      {
        authenticated: false,
        reason: explain(hasAccessToken, hasIdentityToken),
        cookies: {
          [ACCESS_TOKEN_COOKIE]: hasAccessToken,
          [IDENTITY_TOKEN_COOKIE]: hasIdentityToken,
        },
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      authenticated: true,
      provider: provider.name,
      user: {
        userId: user.userId,
        email: user.email ?? null,
        signerAddress: user.signerAddress,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function explain(hasAccess: boolean, hasIdentity: boolean): string {
  if (!hasAccess) return "no_session_cookie";
  if (!hasIdentity) {
    // The embedded wallet address lives on the identity token's linked
    // accounts, so an access token alone cannot produce a usable user.
    return "missing_identity_token: enable identity tokens in the Privy dashboard";
  }
  return "token_invalid_or_no_embedded_wallet";
}
