import "server-only";

import { cookies } from "next/headers";

import { serverEnv } from "@/lib/env";
import { createPrivyProvider } from "./privy";
import { AuthNotConfiguredError, type AuthProvider, type AuthenticatedUser } from "./types";

/** Privy's own cookie names — the SDK sets these client-side on login. */
export const ACCESS_TOKEN_COOKIE = "privy-token";
export const IDENTITY_TOKEN_COOKIE = "privy-id-token";

let cached: AuthProvider | null = null;

/** Returns the configured auth provider, or null when credentials are absent. */
export async function getAuthProvider(): Promise<AuthProvider | null> {
  if (cached) return cached;
  try {
    const env = await serverEnv();
    cached = createPrivyProvider(env);
    return cached;
  } catch (error) {
    if (error instanceof AuthNotConfiguredError) return null;
    throw error;
  }
}

/**
 * Resolves the current user from the session cookie.
 *
 * Next 16 removed synchronous access to `cookies()`, so this awaits.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const provider = await getAuthProvider();
  if (!provider) return null;

  // Next 16 removed synchronous `cookies()`, so this awaits.
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) return null;

  return provider.verifySession({
    accessToken,
    identityToken: store.get(IDENTITY_TOKEN_COOKIE)?.value,
  });
}

/** Resolves the user or throws — for routes that must not proceed anonymously. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthorizedError";
  }
}
